#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { AuditDetailStore } from "../src/audit-detail-store.mjs";
import { safeId } from "../src/data-root.mjs";
import { writeAuditFilesAtomic } from "../src/audit-storage.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((item) => { const [key, ...rest] = item.replace(/^--/, "").split("="); return [key, rest.join("=") || true]; }));
if (!args.audit || !args.page || (!args.desktop && !args.mobile)) throw new Error("Uso: node scripts/attach-page-evidence.mjs --audit=<id> --page=<page-id> [--desktop=/tmp/captura] [--mobile=/tmp/captura] [--dom=/tmp/rendered.html]");
const auditId = safeId(args.audit, "auditId"), pageId = safeId(args.page, "pageId"), store = new AuditDetailStore();
const detail = await store.getPage(auditId, pageId), screenshots = [], files = [];

async function saveImage(source, basename, label) {
  const bytes = await readFile(String(source));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (bytes.length > 20_000_000 || (!png && !jpeg)) throw new Error(`${label} debe ser un PNG o JPEG válido de máximo 20 MB.`);
  const name = `${basename}.${png ? "png" : "jpg"}`;
  files.push({ relativePath: `pages/${pageId}/assets/${name}`, bytes });
  screenshots.push({ label, path: name });
}
if (args.desktop) await saveImage(args.desktop, "desktop", "Captura desktop");
if (args.mobile) await saveImage(args.mobile, "mobile", "Captura móvil");
const page = { ...detail.page, metrics: detail.metrics, screenshots: [...(detail.page.screenshots || []).filter((item) => !screenshots.some((saved) => saved.path === item.path)), ...screenshots] };
page.evidence = { ...(page.evidence || {}), dom: Boolean(args.dom || page.evidence?.dom), screenshots: screenshots.length > 0 || Boolean(page.evidence?.screenshots) };
if (args.dom) {
  const dom = (await readFile(String(args.dom), "utf8")).slice(0, 5_000_000);
  page.response = { ...(page.response || {}), renderedDom: true };
  page.metadata = { ...(page.metadata || {}), renderedTitle: dom.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "", renderedH1Count: [...dom.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi)].length };
}
page.diagnostics = (page.diagnostics || []).filter((item) => item.code !== "deep-browser-evidence-pending");
if (!page.performance || Object.keys(page.performance).length === 0) page.diagnostics.push({ code: "deep-performance-data-pending", stage: "deep-audit", source: "lighthouse", scope: page.url, message: "Las capturas y el DOM están disponibles, pero faltan métricas de rendimiento verificadas.", retryable: true, completenessImpact: "La evidencia visual está completa; CWV/Lighthouse permanece sin cobertura.", nextAction: "Ejecutar Lighthouse o consultar CrUX y guardar únicamente los resultados obtenidos.", attemptedAt: new Date().toISOString() });
if (files.length) await writeAuditFilesAtomic(auditId, files);
await store.savePageBatch(auditId, [page]);
console.log(JSON.stringify({ auditId, pageId, screenshots: page.screenshots, renderedDom: Boolean(page.response?.renderedDom) }, null, 2));
