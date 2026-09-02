import type { APIRoute } from "astro";
import { AuditStore } from "../../../../../audit-store.mjs";
import { BusinessProfileCaptureStore } from "../../../../../business-profile-capture-store.mjs";

const csvCell = (value: unknown) => {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export const GET: APIRoute = async ({ params }) => {
  try {
    const { manifest } = await new AuditStore().get(params.id);
    const state = await new BusinessProfileCaptureStore().get(manifest.businessProfileCapture);
    const performance = state.capture?.performance;
    if (!performance?.series?.length) return new Response("Rendimiento local no disponible", { status: state.status === "expired" ? 410 : 404, headers: { "Cache-Control": "no-store" } });
    const dates = [...new Set(performance.series.flatMap((series: any) => series.points.map((point: any) => point.date)))].sort();
    const rows = [["fecha", ...performance.series.map((series: any) => series.label)], ...dates.map((date) => [date, ...performance.series.map((series: any) => series.points.find((point: any) => point.date === date)?.value ?? null)])];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new Response(`\uFEFF${csv}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${manifest.project.slug}-business-profile.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Rendimiento local no disponible", { status: 404, headers: { "Cache-Control": "no-store" } }); }
};
