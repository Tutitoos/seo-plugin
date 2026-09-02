#!/usr/bin/env node
import { safeId } from "../src/data-root.mjs";
import { AuditDetailStore } from "../src/audit-detail-store.mjs";
import { AuditRunStore } from "../src/run-status.mjs";
import { ProjectSettingsStore } from "../src/project-settings-store.mjs";
import { assertWebTarget } from "../src/url-policy.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((item) => { const [key, ...rest] = item.replace(/^--/, "").split("="); return [key, rest.join("=") || true]; }));
if (!args.audit || !args.page) throw new Error("Uso: node scripts/run-lighthouse-page.mjs --audit=<id> --page=<page-id> [--repeats=1]");
const auditId = safeId(args.audit, "auditId"), pageId = safeId(args.page, "pageId"), detailStore = new AuditDetailStore(), runs = new AuditRunStore();
const detail = await detailStore.getPage(auditId, pageId);
const projectConfig = await new ProjectSettingsStore().resolved(detail.manifest.project.slug);
try { assertWebTarget(detail.page.url, { allowPrivateHosts: projectConfig.allowPrivateHosts === true }); }
catch (error) {
  const item = { code: error.code || "non-web-protocol-blocked", stage: "lighthouse", source: "lighthouse", scope: detail.page.url, message: error.message, retryable: false, completenessImpact: "Lighthouse no accede a destinos privados o protocolos no web.", nextAction: "Usa una URL HTTP/HTTPS pública o habilita allowPrivateHosts para un proyecto local controlado." };
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((entry) => entry.code !== item.code), item] }]);
  await runs.update(auditId, { stage: "lighthouse", status: "partial", diagnostics: [item] });
  console.log(JSON.stringify({ auditId, pageId, measured: false, reason: item.code }, null, 2));
  process.exit(0);
}

function chromeCandidates() {
  const env = process.env.SEO_CHROME_PATH ? [process.env.SEO_CHROME_PATH] : [];
  if (process.platform === "darwin") return [...env, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  if (process.platform === "win32") return [...env, `${process.env.PROGRAMFILES || "C:/Program Files"}/Google/Chrome/Application/chrome.exe`, `${process.env.LOCALAPPDATA || "C:/Users/Default/AppData/Local"}/Google/Chrome/Application/chrome.exe`];
  return [...env, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}
const { access } = await import("node:fs/promises");
let chromePath = null;
for (const candidate of chromeCandidates()) { try { await access(candidate); chromePath = candidate; break; } catch {} }
const diagnostic = (code, message, nextAction) => ({ code, stage: "lighthouse", source: "lighthouse", scope: detail.page.url, message, retryable: true, completenessImpact: "La evidencia de navegador puede estar disponible, pero no hay métricas Lighthouse verificadas.", nextAction });

let lighthouse, launch;
try { ({ default: lighthouse } = await import("lighthouse")); ({ launch } = await import("chrome-launcher")); }
catch {
  const item = diagnostic("lighthouse-runtime-unavailable", "Las dependencias de Lighthouse no están instaladas.", "Ejecuta npm install en el plugin y reintenta la fase Lighthouse.");
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((entry) => entry.code !== item.code), item] }]);
  await runs.update(auditId, { stage: "lighthouse", status: "partial", diagnostics: [item] });
  console.log(JSON.stringify({ auditId, pageId, measured: false, reason: item.code }, null, 2));
  process.exit(0);
}
if (!chromePath) {
  const item = diagnostic("browser-unavailable", "No se encontró Chrome o Chromium para Lighthouse.", "Instala Chrome/Chromium o configura SEO_CHROME_PATH y reintenta.");
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((entry) => entry.code !== item.code), item] }]);
  await runs.update(auditId, { stage: "lighthouse", status: "partial", diagnostics: [item] });
  console.log(JSON.stringify({ auditId, pageId, measured: false, reason: item.code }, null, 2));
  process.exit(0);
}

const repeats = Math.max(1, Math.min(3, Number(args.repeats) || 1));
const measurements = { mobile: [], desktop: [] };
let chrome;
try {
  for (const formFactor of ["mobile", "desktop"]) {
    for (let run = 0; run < repeats; run += 1) {
      chrome = await launch({ chromePath, chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run"] });
      try {
        const result = await lighthouse(detail.page.url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "seo"], formFactor, screenEmulation: formFactor === "mobile" ? { mobile: true, width: 390, height: 844, deviceScaleFactor: 1, disabled: false } : { mobile: false, width: 1440, height: 1000, deviceScaleFactor: 1, disabled: false } });
        const audits = result.lhr.audits;
        measurements[formFactor].push({ performanceScore: Math.round((result.lhr.categories.performance?.score || 0) * 100), accessibilityScore: Math.round((result.lhr.categories.accessibility?.score || 0) * 100), seoScore: Math.round((result.lhr.categories.seo?.score || 0) * 100), lcpMs: audits["largest-contentful-paint"]?.numericValue ?? null, fcpMs: audits["first-contentful-paint"]?.numericValue ?? null, cls: audits["cumulative-layout-shift"]?.numericValue ?? null, tbtMs: audits["total-blocking-time"]?.numericValue ?? null, speedIndexMs: audits["speed-index"]?.numericValue ?? null, run: run + 1 });
      } finally { await chrome.kill().catch(() => {}); chrome = null; }
    }
  }
  const median = (values) => { const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
  const aggregate = Object.fromEntries(Object.entries(measurements).map(([key, rows]) => [key, { runs: rows.length, median: Object.fromEntries(["performanceScore", "accessibilityScore", "seoScore", "lcpMs", "fcpMs", "cls", "tbtMs", "speedIndexMs"].map((field) => [field, median(rows.map((row) => row[field]))])), samples: rows }]));
  const nextPage = { ...detail.page, evidence: { ...(detail.page.evidence || {}), lighthouse: true }, performance: { ...(detail.page.performance || {}), source: "Lighthouse", lab: aggregate, measuredAt: new Date().toISOString(), executablePath: chromePath }, diagnostics: (detail.page.diagnostics || []).filter((item) => !item.code.startsWith("lighthouse-") && item.code !== "browser-unavailable") };
  await detailStore.savePageBatch(auditId, [nextPage]);
  const currentRun = await runs.get(auditId);
  await runs.update(auditId, { stage: "lighthouse", status: "partial", lighthousePages: [...new Set([...(currentRun.lighthousePages || []), pageId])] });
  console.log(JSON.stringify({ auditId, pageId, measured: true, performance: aggregate }, null, 2));
} catch (error) {
  if (chrome) await chrome.kill().catch(() => {});
  const item = diagnostic("lighthouse-failed", error.message || "Falló Lighthouse.", "Revisar la URL, Chrome y los límites de tiempo; reintentar la página.");
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((entry) => entry.code !== item.code), item] }]);
  await runs.update(auditId, { stage: "lighthouse", status: "partial", diagnostics: [item] });
  console.error(JSON.stringify({ auditId, pageId, measured: false, reason: item.code, message: error.message }, null, 2));
}
