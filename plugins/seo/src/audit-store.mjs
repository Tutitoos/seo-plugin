import { mkdir, readFile, readdir, writeFile, rename, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ensureDataRoot, insideDataRoot, safeId } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";
import { ProjectSettingsStore } from "./project-settings-store.mjs";

const STATUSES = new Set(["draft", "completed", "failed"]);
const KPI_POLICIES = new Set(["higher-is-better", "lower-is-better", "informational"]);
const KPI_FORMATS = new Set(["integer", "decimal", "percent", "duration-ms", "duration-s", "currency", "score"]);
const DATASET_TYPES = new Set(["timeseries", "categorical", "matrix"]);
const GRANULARITIES = new Set(["day", "week", "month", "snapshot", "none"]);
const CHART_TYPES = new Set(["line", "area", "bar", "stacked-bar", "donut", "scatter", "heatmap"]);
const CHART_SECTIONS = new Set(["summary", "visibility", "traffic", "local", "technical", "content"]);
const CHART_COLORS = new Set(["lime", "blue", "orange", "green", "red", "ink"]);
const COLORS = ["lime", "blue", "orange", "green", "red", "ink"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function safeKey(value, field) {
  const normalized = String(value || "serie").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return safeId(normalized || "serie", field);
}

function text(value, label, maxLength, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`${label} es obligatorio.`);
  if (result.length > maxLength) throw new Error(`${label} supera ${maxLength} caracteres.`);
  return result;
}

function finite(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (!Number.isFinite(value)) throw new Error(`${label} debe ser un número finito.`);
  return value;
}

function period(value, label) {
  if (!value) return null;
  if (!DATE.test(value.startDate) || !DATE.test(value.endDate) || value.startDate > value.endDate) throw new Error(`${label} requiere fechas ISO ordenadas.`);
  const granularity = value.granularity || "day";
  if (!GRANULARITIES.has(granularity)) throw new Error(`${label}.granularity no es válida.`);
  return { startDate: value.startDate, endDate: value.endDate, granularity };
}

function formatValue(value, format, precision = 1, currency = "EUR") {
  const options = { maximumFractionDigits: precision };
  if (format === "integer") return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(value);
  if (format === "percent") return `${new Intl.NumberFormat("es-ES", options).format(value)}%`;
  if (format === "duration-ms") return `${new Intl.NumberFormat("es-ES", options).format(value)} ms`;
  if (format === "duration-s") return `${new Intl.NumberFormat("es-ES", options).format(value)} s`;
  if (format === "currency") return new Intl.NumberFormat("es-ES", { style: "currency", currency, ...options }).format(value);
  if (format === "score") return `${new Intl.NumberFormat("es-ES", options).format(value)}/100`;
  return new Intl.NumberFormat("es-ES", options).format(value);
}

function targetStatus(value, target) {
  if (!target) return null;
  if (target.operator === "eq") return value === target.value ? "positive" : "negative";
  if (target.operator === "between") return value >= target.value && value <= target.maxValue ? "positive" : "negative";
  if (target.operator === "lte") {
    if (value <= target.value) return "positive";
    if (target.warningValue != null && value <= target.warningValue) return "warning";
    return "negative";
  }
  if (value >= target.value) return "positive";
  if (target.warningValue != null && value >= target.warningValue) return "warning";
  return "negative";
}

function normalizeKpis(value, previous, settings) {
  if (value === undefined) return previous || [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("kpis debe contener como máximo 32 elementos.");
  return value.map((item, index) => {
    const id = safeId(item.id, `kpis[${index}].id`);
    const current = finite(item.value, `kpis[${index}].value`);
    const previousValue = finite(item.previousValue, `kpis[${index}].previousValue`, true);
    const format = item.format || (item.formatted?.includes("%") ? "percent" : "decimal");
    if (!KPI_FORMATS.has(format)) throw new Error(`kpis[${index}].format no es válido.`);
    const policy = item.policy || "informational";
    if (!KPI_POLICIES.has(policy)) throw new Error(`kpis[${index}].policy no es válida.`);
    const precision = Number.isInteger(item.precision) && item.precision >= 0 && item.precision <= 4 ? item.precision : 1;
    const target = item.target || settings.targets[id] || null;
    const delta = previousValue == null ? null : current - previousValue;
    const deltaPercent = previousValue == null || previousValue === 0 ? null : delta / Math.abs(previousValue) * 100;
    const trend = delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
    let sentiment = targetStatus(current, target);
    if (!sentiment && delta != null && policy !== "informational") sentiment = (delta > 0) === (policy === "higher-is-better") ? "positive" : delta === 0 ? "neutral" : "negative";
    sentiment ||= item.sentiment || "neutral";
    return {
      id, label: text(item.label, `kpis[${index}].label`, 80, true), value: current, previousValue, format, precision,
      unit: text(item.unit, `kpis[${index}].unit`, 24), policy, target, delta, deltaPercent, trend, sentiment,
      formatted: text(item.formatted, `kpis[${index}].formatted`, 40) || formatValue(current, format, precision, settings.currency),
      previousFormatted: previousValue == null ? null : text(item.previousFormatted, `kpis[${index}].previousFormatted`, 40) || formatValue(previousValue, format, precision, settings.currency),
      source: text(item.source, `kpis[${index}].source`, 100, true),
      context: item.context == null ? null : text(item.context, `kpis[${index}].context`, 180),
      datasetId: item.datasetId ? safeId(item.datasetId, `kpis[${index}].datasetId`) : null,
      datasetSeriesKey: item.datasetSeriesKey ? safeId(item.datasetSeriesKey, `kpis[${index}].datasetSeriesKey`) : null,
    };
  });
}

function normalizeSeries(series, label) {
  if (!Array.isArray(series) || series.length < 1 || series.length > 12) throw new Error(`${label} debe contener entre 1 y 12 series.`);
  return series.map((item, index) => ({
    key: safeId(item.key || item.name, `${label}[${index}].key`), label: text(item.label || item.name, `${label}[${index}].label`, 60, true),
    unit: text(item.unit, `${label}[${index}].unit`, 24), color: CHART_COLORS.has(item.color) ? item.color : COLORS[index % COLORS.length], axis: item.axis === "right" ? "right" : "left", aggregation: ["sum", "average", "weighted-average", "last"].includes(item.aggregation) ? item.aggregation : "sum", weightKey: item.weightKey ? safeId(item.weightKey, `${label}[${index}].weightKey`) : null,
  }));
}

function normalizeValues(values, aliases, label) {
  return Object.fromEntries(aliases.map(({ key, sourceKey }) => {
    const value = values?.[sourceKey] ?? values?.[key];
    return [key, value == null ? null : finite(value, `${label}.${key}`)];
  }));
}

function normalizeDataset(dataset, index) {
  const id = safeId(dataset.id, `datasets[${index}].id`);
  const type = dataset.type || "categorical";
  if (!DATASET_TYPES.has(type)) throw new Error(`datasets[${index}].type no es válido.`);
  const granularity = dataset.granularity || (type === "timeseries" ? "day" : "none");
  if (!GRANULARITIES.has(granularity)) throw new Error(`datasets[${index}].granularity no es válida.`);
  const series = normalizeSeries(dataset.series, `datasets[${index}].series`);
  const keys = series.map((item) => item.key);
  const aliases = series.map((item, seriesIndex) => ({ key: item.key, sourceKey: String(dataset.series[seriesIndex]?.key || dataset.series[seriesIndex]?.name || item.key) }));
  const limit = type === "matrix" ? 2500 : 500;
  if (!Array.isArray(dataset.rows) || dataset.rows.length < 1 || dataset.rows.length > limit) throw new Error(`datasets[${index}].rows debe contener entre 1 y ${limit} filas.`);
  let rows = dataset.rows.map((row, rowIndex) => {
    if (type === "timeseries") {
      if (!DATE.test(row.date)) throw new Error(`datasets[${index}].rows[${rowIndex}].date no es ISO.`);
      return { date: row.date, values: normalizeValues(row.values, aliases, `datasets[${index}].rows[${rowIndex}]`) };
    }
    if (type === "matrix") return { x: text(row.x, "matrix.x", 80, true), y: text(row.y, "matrix.y", 80, true), value: finite(row.value, "matrix.value") };
    return { label: text(row.label, "categorical.label", 100, true), values: normalizeValues(row.values, aliases, `datasets[${index}].rows[${rowIndex}]`) };
  });
  if (type === "timeseries" && granularity === "day") {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const byDate = new Map(rows.map((row) => [row.date, row]));
    if (byDate.size !== rows.length) throw new Error(`datasets[${index}] contiene fechas duplicadas.`);
    const filled = [];
    for (let cursor = new Date(`${rows[0].date}T00:00:00Z`), end = new Date(`${rows.at(-1).date}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      filled.push(byDate.get(date) || { date, values: Object.fromEntries(keys.map((key) => [key, null])) });
      if (filled.length > 500) throw new Error(`datasets[${index}] supera 500 días tras completar huecos.`);
    }
    rows = filled;
  }
  return { id, type, title: text(dataset.title, `datasets[${index}].title`, 120), source: text(dataset.source, `datasets[${index}].source`, 100, true), granularity, series, rows };
}

function legacyCharts(charts = []) {
  const datasets = [];
  const normalizedCharts = [];
  for (const chart of charts) {
    const datasetId = `${safeId(chart.id, "chart.id")}-data`;
    const series = (chart.series || []).map((item, index) => ({ key: safeKey(item.name, "series.name"), label: item.name, unit: chart.unit || "", color: item.color || COLORS[index % COLORS.length] }));
    const rows = (chart.series?.[0]?.points || []).map((point, pointIndex) => ({ label: point.label, values: Object.fromEntries(series.map((meta, seriesIndex) => [meta.key, chart.series[seriesIndex]?.points?.[pointIndex]?.value ?? null])) }));
    if (!series.length || !rows.length) continue;
    datasets.push({ id: datasetId, type: "categorical", title: chart.title, source: chart.source, granularity: "none", series, rows });
    normalizedCharts.push({ id: chart.id, title: chart.title, type: chart.type, description: chart.description || "", section: "summary", engine: ["bar", "donut"].includes(chart.type) ? "native" : "echarts", datasetId, seriesKeys: series.map((item) => item.key), compareMode: "none", annotations: [] });
  }
  return { datasets, charts: normalizedCharts };
}

function normalizeCharts(charts, datasets, previous = []) {
  if (charts === undefined) return previous;
  if (!Array.isArray(charts) || charts.length > 24) throw new Error("charts debe contener como máximo 24 elementos.");
  const datasetIds = new Set(datasets.map((dataset) => dataset.id));
  return charts.map((chart, index) => {
    const type = chart.type || "line";
    if (!CHART_TYPES.has(type)) throw new Error(`charts[${index}].type no es válido.`);
    const section = chart.section || "summary";
    if (!CHART_SECTIONS.has(section)) throw new Error(`charts[${index}].section no es válida.`);
    const datasetId = safeId(chart.datasetId, `charts[${index}].datasetId`);
    if (!datasetIds.has(datasetId)) throw new Error(`charts[${index}] referencia un dataset inexistente.`);
    const dataset = datasets.find((item) => item.id === datasetId);
    const validKeys = new Set(dataset.series.map((item) => item.key));
    const seriesKeys = (chart.seriesKeys?.length ? chart.seriesKeys : dataset.series.map((item) => item.key)).map((key) => safeId(key, "seriesKey"));
    if (seriesKeys.some((key) => !validKeys.has(key))) throw new Error(`charts[${index}] referencia una serie inexistente.`);
    return {
      id: safeId(chart.id, `charts[${index}].id`), title: text(chart.title, `charts[${index}].title`, 120, true), type,
      description: text(chart.description, `charts[${index}].description`, 240), section,
      engine: chart.engine === "echarts" ? "echarts" : ["bar", "donut"].includes(type) && dataset.type === "categorical" ? "native" : "echarts",
      datasetId, seriesKeys, compareMode: chart.compareMode === "previous-period" ? "previous-period" : "none",
      annotations: (chart.annotations || []).slice(0, 20).map((annotation) => ({ date: DATE.test(annotation.date) ? annotation.date : null, label: text(annotation.label, "annotation.label", 100, true), type: ["audit", "change", "warning"].includes(annotation.type) ? annotation.type : "change" })),
    };
  });
}

function legacyMetrics(manifest = {}) {
  const converted = legacyCharts(manifest.charts || []);
  return { version: 2, kpis: manifest.kpis || [], datasets: converted.datasets, charts: converted.charts };
}

function normalizeCoverage(value, previous = []) {
  if (value === undefined) return previous;
  if (!Array.isArray(value) || value.length > 20) throw new Error("sourceCoverage debe contener como máximo 20 fuentes.");
  return value.map((item, index) => ({ id: safeId(item.id, `sourceCoverage[${index}].id`), label: text(item.label, "sourceCoverage.label", 80, true), status: ["available", "partial", "unavailable"].includes(item.status) ? item.status : "unavailable", detail: text(item.detail, "sourceCoverage.detail", 180), updatedAt: item.updatedAt || null }));
}

function normalizeExecutive(value, previous = {}) {
  if (value === undefined) return previous || {};
  const priorities = Array.isArray(value.priorities) ? value.priorities.slice(0, 5).map((item, index) => ({
    title: text(item.title, `executive.priorities[${index}].title`, 140, true),
    why: text(item.why, `executive.priorities[${index}].why`, 400, true),
    validation: text(item.validation, `executive.priorities[${index}].validation`, 400, true),
    findingId: item.findingId ? safeId(item.findingId, `executive.priorities[${index}].findingId`) : null,
  })) : [];
  return { state: text(value.state, "executive.state", 600), change: text(value.change, "executive.change", 600), priorities };
}

export class AuditStore {
  constructor({ settings = new ProjectSettingsStore(), now = () => new Date().toISOString() } = {}) { this.settings = settings; this.now = now; }

  async save(input) {
    await ensureDataRoot();
    const existingId = input.id ? safeId(input.id, "auditId") : null;
    const projectSlug = safeId(input.project?.slug, "project.slug");
    const timestampId = this.now().replace(/[-:TZ.]/g, "").slice(0, 14);
    const id = existingId || `${projectSlug}-seo-full-${timestampId}-${randomUUID().slice(0, 6)}`;
    const folder = insideDataRoot("audits", id);
    const manifestPath = insideDataRoot("audits", id, "manifest.json");
    const metricsPath = insideDataRoot("audits", id, "metrics.json");
    const reportPath = insideDataRoot("audits", id, "report.md");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const previous = await readJson(manifestPath, {});
    if (previous.status === "completed") throw new Error(`La auditoría ${id} está completada y es inmutable. Crea un nuevo snapshot.`);
    const previousMetrics = previous.version >= 2 ? await readJson(metricsPath, { version: previous.version, kpis: [], datasets: [], charts: [] }) : legacyMetrics(previous);
    const project = { slug: projectSlug, name: text(input.project?.name || previous.project?.name, "project.name", 120, true) };
    const settings = await this.settings.resolved(project.slug);
    let datasets;
    let chartsInput = input.charts;
    if (input.datasets !== undefined) datasets = input.datasets.map(normalizeDataset);
    else if (chartsInput?.some((chart) => !chart.datasetId)) {
      const converted = legacyCharts(chartsInput); datasets = converted.datasets.map(normalizeDataset); chartsInput = converted.charts;
    } else datasets = previousMetrics.datasets || [];
    const metrics = { version: 3, kpis: normalizeKpis(input.kpis, previousMetrics.kpis, settings), datasets, charts: normalizeCharts(chartsInput, datasets, previousMetrics.charts) };
    const status = input.status || previous.status || "completed";
    if (!STATUSES.has(status)) throw new Error("status debe ser draft, completed o failed.");
    const score = input.score ?? previous.score ?? null;
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error("score debe estar entre 0 y 100.");
    const now = this.now();
    const manifest = {
      version: 3, id, title: text(input.title || previous.title, "title", 180, true), project,
      profileId: input.profileId ? safeId(input.profileId, "profileId") : previous.profileId || null,
      auditType: safeId(input.auditType || previous.auditType || "seo-full", "auditType"), status, score,
      summary: text(input.summary ?? previous.summary, "summary", 500),
      executive: normalizeExecutive(input.executive, previous.executive),
      periods: { primary: period(input.periods?.primary, "periods.primary") || previous.periods?.primary || null, comparison: period(input.periods?.comparison, "periods.comparison") || previous.periods?.comparison || null, history: period(input.periods?.history, "periods.history") || previous.periods?.history || null },
      sourceCoverage: normalizeCoverage(input.sourceCoverage, previous.sourceCoverage || []),
      skillsUsed: [...new Set(input.skillsUsed || previous.skillsUsed || [])].map((item) => safeId(item, "skill")),
      tags: [...new Set(input.tags || previous.tags || [])].map((item) => text(item, "tag", 60)).filter(Boolean), artifacts: previous.artifacts || [], content: previous.content || {},
      metrics: { path: "metrics.json", kpiCount: metrics.kpis.length, datasetCount: metrics.datasets.length, chartCount: metrics.charts.length },
      createdAt: previous.createdAt || now, updatedAt: now, completedAt: status === "completed" ? now : null,
    };
    await writeJsonAtomic(metricsPath, metrics);
    await writeJsonAtomic(manifestPath, manifest);
    if (typeof input.reportMarkdown === "string") {
      const temporary = `${reportPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, input.reportMarkdown, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, reportPath);
    }
    return { ...manifest, ...metrics };
  }

  async list(filters = {}) {
    await ensureDataRoot();
    const root = insideDataRoot("audits");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      try { manifests.push(await readJson(insideDataRoot("audits", entry.name, "manifest.json"), null)); } catch {}
    }
    const query = text(filters.query, "query", 200).toLowerCase();
    let results = manifests.filter(Boolean).filter((item) => {
      if (filters.project && item.project?.slug !== filters.project) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (filters.auditType && item.auditType !== filters.auditType) return false;
      if (filters.dateFrom && item.createdAt.slice(0, 10) < filters.dateFrom) return false;
      if (filters.dateTo && item.createdAt.slice(0, 10) > filters.dateTo) return false;
      return !query || `${item.title} ${item.summary} ${item.project?.name} ${(item.tags || []).join(" ")}`.toLowerCase().includes(query);
    });
    results.sort((a, b) => (filters.order === "asc" ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
    if (filters.latestOnly) results = [...new Map(results.map((item) => [item.project.slug, item])).values()];
    return results;
  }

  async get(id) {
    id = safeId(id, "auditId");
    const manifest = await readJson(insideDataRoot("audits", id, "manifest.json"), null);
    if (!manifest) throw new Error(`No existe la auditoría ${id}.`);
    const metrics = manifest.version >= 2 ? await readJson(insideDataRoot("audits", id, "metrics.json"), { version: manifest.version, kpis: [], datasets: [], charts: [] }) : legacyMetrics(manifest);
    let reportMarkdown = "";
    try { reportMarkdown = await readFile(insideDataRoot("audits", id, "report.md"), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { manifest, metrics, reportMarkdown };
  }

  async projectHistory(projectId) {
    const audits = await this.list({ project: safeId(projectId, "projectId"), order: "asc" });
    const snapshots = [];
    for (const audit of audits) {
      const { metrics } = await this.get(audit.id);
      snapshots.push({ id: audit.id, title: audit.title, status: audit.status, score: audit.score, createdAt: audit.createdAt, kpis: metrics.kpis.map(({ id, value, formatted, sentiment }) => ({ id, value, formatted, sentiment })) });
    }
    return { projectId, snapshots };
  }
}
