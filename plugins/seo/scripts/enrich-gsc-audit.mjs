#!/usr/bin/env node
import process from "node:process";
import { AuditStore } from "../src/audit-store.mjs";

const auditId = process.argv[2];
if (!auditId) throw new Error("Uso: enrich-gsc-audit.mjs <audit-id> (JSON por stdin)");
let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body || "{}");
const store = new AuditStore();
const audit = await store.get(auditId);
const datasets = structuredClone(audit.metrics.datasets);
const charts = structuredClone(audit.metrics.charts);
const daily = datasets.find((item) => item.id === "gsc-daily");
if (!daily) throw new Error("La auditoría no contiene el dataset gsc-daily.");

function rolling(rows, key, size) {
  return rows.map((_, index) => {
    const values = rows.slice(Math.max(0, index - size + 1), index + 1).map((row) => row.values[key]).filter(Number.isFinite);
    return values.length === size ? values.reduce((sum, value) => sum + value, 0) / size : null;
  });
}
const clicks7 = rolling(daily.rows, "clicks", 7);
const clicks28 = rolling(daily.rows, "clicks", 28);
daily.rows.forEach((row, index) => { row.values.clicks7 = clicks7[index]; row.values.clicks28 = clicks28[index]; });
for (const series of [
  { key: "clicks7", label: "Media móvil 7 días", unit: "clics", color: "blue", aggregation: "average" },
  { key: "clicks28", label: "Media móvil 28 días", unit: "clics", color: "orange", aggregation: "average" },
]) if (!daily.series.some((item) => item.key === series.key)) daily.series.push(series);

function rows(value) { return value?.rows || value?.structuredContent?.rows || []; }
function compare(current, previous, dimension, limit = 16) {
  const before = new Map(rows(previous).map((row) => [row.dimensions?.[dimension], row]));
  return rows(current).map((row) => {
    const label = row.dimensions?.[dimension]; const old = before.get(label) || {};
    return { label, values: { clicks: row.clicks, previousClicks: old.clicks || 0, clickDelta: row.clicks - (old.clicks || 0), impressions: row.impressions, previousImpressions: old.impressions || 0, ctr: row.ctr * 100, previousCtr: (old.ctr || 0) * 100, position: row.position, previousPosition: old.position ?? null } };
  }).filter((row) => row.label).sort((a, b) => Math.abs(b.values.clickDelta) - Math.abs(a.values.clickDelta)).slice(0, limit);
}
const queryRows = compare(input.queryCurrent, input.queryPrevious, "query", 20);
const pageRows = compare(input.pageCurrent, input.pagePrevious, "page", 30);
const queryDataset = { id: "gsc-query-movers", type: "categorical", source: "Google Search Console · filas principales, no total exhaustivo", granularity: "none", series: [
  { key: "clickDelta", label: "Variación de clics", unit: "clics", color: "lime" },
  { key: "clicks", label: "Clics actuales", unit: "clics", color: "blue" },
  { key: "previousClicks", label: "Clics anteriores", unit: "clics", color: "ink" },
], rows: queryRows };
const pageDataset = { id: "gsc-page-opportunities", type: "categorical", source: "Google Search Console · filas principales, no total exhaustivo", granularity: "none", series: [
  { key: "impressions", label: "Impresiones", unit: "impresiones", color: "blue" },
  { key: "ctr", label: "CTR", unit: "%", color: "lime" },
  { key: "position", label: "Posición media", unit: "posición", color: "orange", axis: "right" },
], rows: pageRows };
for (const next of [queryDataset, pageDataset]) { const index = datasets.findIndex((item) => item.id === next.id); if (index === -1) datasets.push(next); else datasets[index] = next; }

const additions = [
  { id: "organic-click-momentum", title: "Momentum orgánico: medias móviles de clics", description: "La media de 7 días detecta cambios rápidos; la de 28 días separa tendencia de ruido diario.", type: "line", engine: "echarts", section: "visibility", datasetId: "gsc-daily", seriesKeys: ["clicks7", "clicks28"], compareMode: "none" },
  { id: "query-winners-losers", title: "Consultas ganadoras y perdedoras", description: "Variación de clics frente a los 90 días anteriores. Search Console limita y anonimiza filas, por lo que no representa el total agregado.", type: "bar", engine: "echarts", section: "content", datasetId: "gsc-query-movers", seriesKeys: ["clickDelta"], compareMode: "none" },
  { id: "page-opportunities", title: "Oportunidades por landing", description: "Cruza impresiones y CTR de las principales páginas para priorizar snippets y contenido.", type: "scatter", engine: "echarts", section: "content", datasetId: "gsc-page-opportunities", seriesKeys: ["impressions", "ctr"], compareMode: "none" },
];
for (const next of additions) { const index = charts.findIndex((item) => item.id === next.id); if (index === -1) charts.push(next); else charts[index] = next; }

const saved = await store.save({ id: auditId, project: audit.manifest.project, datasets, charts });
process.stdout.write(JSON.stringify({ id: saved.id, datasets: saved.datasetCount, charts: saved.chartCount, queryRows: queryRows.length, pageRows: pageRows.length }) + "\n");
