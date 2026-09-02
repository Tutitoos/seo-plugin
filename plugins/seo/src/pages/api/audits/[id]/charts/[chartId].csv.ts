import type { APIRoute } from "astro";
import { AuditStore } from "../../../../../audit-store.mjs";

const csvCell = (value: unknown) => {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export const GET: APIRoute = async ({ params }) => {
  try {
    const { manifest, metrics } = await new AuditStore().get(params.id);
    const chart = metrics.charts.find((item: any) => item.id === params.chartId);
    const dataset = chart && metrics.datasets.find((item: any) => item.id === chart.datasetId);
    if (!chart || !dataset) return new Response("Gráfica no encontrada", { status: 404 });
    const header = dataset.type === "matrix" ? ["x", "y", "value"] : [dataset.type === "timeseries" ? "date" : "label", ...dataset.series.map((series: any) => series.label)];
    const rows = dataset.rows.map((row: any) => dataset.type === "matrix" ? [row.x, row.y, row.value] : [row.date || row.label, ...dataset.series.map((series: any) => row.values[series.key])]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new Response(`\uFEFF${csv}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${manifest.project.slug}-${chart.id}.csv"`, "Cache-Control": "no-store" } });
  } catch {
    return new Response("Auditoría no encontrada", { status: 404 });
  }
};
