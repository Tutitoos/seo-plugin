import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("guarda, filtra y recupera una auditoría privada", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}`);
  const store = new AuditStore();
  const saved = await store.save({ id: "audit-one", title: "Auditoría técnica", project: { slug: "taxiprime", name: "TaxiPrime" }, profileId: "taxiprime", auditType: "seo-audit", status: "completed", score: 91, summary: "Sin bloqueos críticos", skillsUsed: ["seo-audit"], tags: ["production"], kpis: [{ id: "organic-clicks", label: "Clics orgánicos", value: 232, formatted: "232", previousValue: 174, previousFormatted: "174", delta: "+33,3%", sentiment: "positive", source: "Search Console", context: "90 días frente al periodo anterior" }], charts: [{ id: "clicks-period", title: "Clics por periodo", type: "bar", description: "Comparativa homogénea", unit: "", source: "Search Console", series: [{ name: "Clics", color: "lime", points: [{ label: "Anterior", value: 174 }, { label: "Actual", value: 232 }] }] }], reportMarkdown: "# Resultado\nCorrecto." });
  assert.equal(saved.score, 91);
  assert.equal(saved.version, 4);
  assert.equal(saved.kpis[0].delta, 58);
  assert.equal(Math.round(saved.kpis[0].deltaPercent), 33);
  assert.equal(saved.datasets[0].rows[1].values.clics, 232);
  assert.equal((await store.list({ project: "taxiprime" })).length, 1);
  assert.match((await store.get("audit-one")).reportMarkdown, /Resultado/);
  const mode = (await stat(join(process.env.SEO_PLUGIN_DATA_DIR, "audits", "audit-one", "manifest.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("conserva visualizaciones en actualizaciones parciales", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}p`);
  const store = new AuditStore();
  await store.save({ id: "audit-visual", title: "Visual", project: { slug: "demo", name: "Demo" }, status: "draft", kpis: [{ id: "score", label: "Score", value: 80, formatted: "80/100", source: "Auditoría" }], charts: [{ id: "trend", title: "Tendencia", type: "line", source: "Fuente", series: [{ name: "Valor", points: [{ label: "Ene", value: 1 }, { label: "Feb", value: 2 }] }] }] });
  const updated = await store.save({ id: "audit-visual", title: "Visual revisada", project: { slug: "demo", name: "Demo" } });
  assert.equal(updated.kpis.length, 1);
  assert.equal(updated.charts.length, 1);
});

test("rechaza visualizaciones inválidas o sin límites", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}v`);
  const base = { id: "audit-invalid", title: "Inválida", project: { slug: "demo", name: "Demo" } };
  await assert.rejects(new AuditStore().save({ ...base, kpis: [{ id: "bad", label: "Bad", value: Infinity, formatted: "∞", source: "Test" }] }), /finito/);
  await assert.rejects(new AuditStore().save({ ...base, charts: [{ id: "bad", title: "Bad", type: "pie", source: "Test", series: [{ name: "X", points: [{ label: "A", value: 1 }] }] }] }), /type/);
  await assert.rejects(new AuditStore().save({ ...base, datasets: [{ id: "too-many", type: "categorical", source: "Test", series: [{ key: "x", label: "X" }], rows: Array.from({ length: 501 }, (_, index) => ({ label: String(index), values: { x: index } })) }] }), /500 filas/);
});

test("congela snapshots completados y expone la evolución del proyecto", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}h`);
  const store = new AuditStore();
  await store.save({ id: "snapshot-one", title: "Primera", project: { slug: "demo", name: "Demo" }, status: "completed", score: 70, kpis: [{ id: "score", label: "Score", value: 70, format: "score", source: "Auditoría" }] });
  await assert.rejects(store.save({ id: "snapshot-one", title: "Cambio", project: { slug: "demo", name: "Demo" } }), /inmutable/);
  const history = await store.projectHistory("demo");
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].score, 70);
});

test("guarda datasets temporales, periodos y cobertura sin convertir null en cero", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}t`);
  const store = new AuditStore();
  const saved = await store.save({ title: "Histórica", project: { slug: "demo", name: "Demo" }, status: "draft", periods: { primary: { startDate: "2026-06-01", endDate: "2026-08-29", granularity: "day" } }, sourceCoverage: [{ id: "search-console", label: "Search Console", status: "available", detail: "90 días" }], datasets: [{ id: "organic-history", type: "timeseries", source: "Search Console", granularity: "day", series: [{ key: "clicks", label: "Clics", aggregation: "sum" }], rows: [{ date: "2026-06-01", values: { clicks: 3 } }, { date: "2026-06-03", values: { clicks: 5 } }] }], charts: [{ id: "organic-trend", title: "Tendencia", type: "area", section: "visibility", datasetId: "organic-history" }] });
  assert.equal(saved.datasets[0].rows.length, 3);
  assert.equal(saved.datasets[0].rows[1].values.clicks, null);
  assert.equal(saved.charts[0].engine, "echarts");
  assert.equal(saved.sourceCoverage[0].status, "available");
});

test("normaliza claves camelCase sin perder sus valores", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}c`);
  const saved = await new AuditStore().save({ id: "camel-values", title: "Camel", project: { slug: "demo", name: "Demo" }, datasets: [{ id: "movers", type: "categorical", source: "Test", series: [{ key: "clickDelta", label: "Delta" }], rows: [{ label: "consulta", values: { clickDelta: -4 } }] }], charts: [{ id: "movers-chart", title: "Movers", type: "bar", engine: "echarts", section: "content", datasetId: "movers", seriesKeys: ["clickDelta"] }] });
  assert.equal(saved.datasets[0].rows[0].values.clickdelta, -4);
  assert.equal(saved.charts[0].engine, "echarts");
});

test("rechaza traversal en identificadores de auditoría", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}x`);
  await assert.rejects(new AuditStore().save({ id: "../../escape", title: "No", project: { slug: "x", name: "X" } }), /guiones/);
});
