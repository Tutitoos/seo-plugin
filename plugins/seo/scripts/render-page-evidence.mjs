#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditDetailStore } from "../src/audit-detail-store.mjs";
import { AuditRunStore } from "../src/run-status.mjs";
import { writeAuditFilesAtomic } from "../src/audit-storage.mjs";
import { safeId } from "../src/data-root.mjs";
import { ProjectSettingsStore } from "../src/project-settings-store.mjs";
import { assertWebTarget } from "../src/url-policy.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((item) => { const [key, ...rest] = item.replace(/^--/, "").split("="); return [key, rest.join("=") || true]; }));
if (!args.audit || !args.page) throw new Error("Uso: node scripts/render-page-evidence.mjs --audit=<id> --page=<page-id> [--chrome=/ruta/chrome]");
const auditId = safeId(args.audit, "auditId"), pageId = safeId(args.page, "pageId");
const detailStore = new AuditDetailStore(), runs = new AuditRunStore();
const detail = await detailStore.getPage(auditId, pageId);
const projectConfig = await new ProjectSettingsStore().resolved(detail.manifest.project.slug);
try { assertWebTarget(detail.page.url, { allowPrivateHosts: projectConfig.allowPrivateHosts === true }); }
catch (error) {
  const diagnostic = { code: error.code || "non-web-protocol-blocked", stage: "render", source: "browser", scope: detail.page.url, message: error.message, retryable: false, completenessImpact: "La fase profunda no accede a destinos privados o protocolos no web.", nextAction: "Usa una URL HTTP/HTTPS pública o habilita allowPrivateHosts para un proyecto local controlado." };
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((item) => item.code !== diagnostic.code), diagnostic] }]);
  await runs.update(auditId, { stage: "render", status: "partial", diagnostics: [diagnostic] });
  console.log(JSON.stringify({ auditId, pageId, rendered: false, reason: diagnostic.code }, null, 2));
  process.exit(0);
}

function chromeCandidates() {
  const env = process.env.SEO_CHROME_PATH ? [process.env.SEO_CHROME_PATH] : [];
  if (process.platform === "darwin") return [...env, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  if (process.platform === "win32") return [...env, `${process.env.PROGRAMFILES || "C:/Program Files"}/Google/Chrome/Application/chrome.exe`, `${process.env.LOCALAPPDATA || "C:/Users/Default/AppData/Local"}/Google/Chrome/Application/chrome.exe`];
  return [...env, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

async function findChrome() {
  const { access } = await import("node:fs/promises");
  for (const candidate of (args.chrome ? [String(args.chrome)] : chromeCandidates())) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

async function initialHtmlSnapshot(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "SEO-Workspace-Audit/4.0 (+local read-only audit)" } });
    const html = (await response.text()).slice(0, 5_000_000);
    return { initialHtmlBytes: Buffer.byteLength(html), initialHtmlHash: createHash("sha256").update(html).digest("hex"), initialFinalUrl: response.url, initialStatus: response.status };
  } catch (error) {
    return { initialHtmlBytes: null, initialHtmlHash: null, initialFinalUrl: null, initialStatus: null, initialFetchError: error?.name || "fetch-error" };
  } finally { clearTimeout(timer); }
}

const executablePath = await findChrome();
if (!executablePath) {
  const diagnostic = { code: "browser-unavailable", stage: "render", source: "browser", scope: detail.page.url, message: "No se encontró Chrome o Chromium para renderizar la página.", retryable: true, completenessImpact: "La evidencia HTTP permanece disponible, pero faltan DOM renderizado y capturas.", nextAction: "Instala Chrome/Chromium o configura SEO_CHROME_PATH y reintenta la fase render." };
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((item) => item.code !== diagnostic.code), diagnostic] }]);
  await runs.update(auditId, { stage: "render", status: "partial", diagnostics: [diagnostic] });
  console.log(JSON.stringify({ auditId, pageId, rendered: false, reason: diagnostic.code }, null, 2));
  process.exit(0);
}

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch {
  const diagnostic = { code: "browser-runtime-unavailable", stage: "render", source: "browser", scope: detail.page.url, message: "La dependencia de navegador no está instalada.", retryable: true, completenessImpact: "No se puede ejecutar la fase profunda con navegador real.", nextAction: "Ejecuta npm install en el plugin y vuelve a lanzar /seo full." };
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((item) => item.code !== diagnostic.code), diagnostic] }]);
  await runs.update(auditId, { stage: "render", status: "partial", diagnostics: [diagnostic] });
  console.log(JSON.stringify({ auditId, pageId, rendered: false, reason: diagnostic.code }, null, 2));
  process.exit(0);
}

const tempDir = await mkdtemp(join(tmpdir(), "seo-render-"));
let browser;
try {
  const initial = await initialHtmlSnapshot(detail.page.url);
  browser = await chromium.launch({ headless: true, executablePath, args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", `--user-data-dir=${join(tempDir, "profile")}`] });
  const rendered = [];
  const viewports = [{ name: "desktop", width: 1440, height: 1000, label: "Captura desktop" }, { name: "mobile", width: 390, height: 844, label: "Captura móvil" }];
  let signals = {};
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, javaScriptEnabled: true, ignoreHTTPSErrors: false });
    const page = await context.newPage();
    try {
      await page.goto(detail.page.url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(350);
      if (viewport.name === "desktop") {
        const compactSignals = await page.evaluate(() => ({ declaredLocale: document.documentElement.lang || "", renderedTitle: document.title || "", renderedDescription: document.querySelector('meta[name="description"]')?.getAttribute("content") || "", renderedH1Count: document.querySelectorAll("h1").length, renderedWordCount: (document.body?.innerText || "").trim().split(/\s+/).filter(Boolean).length, renderedDomBytes: document.documentElement.outerHTML.length, renderedHtml: document.documentElement.outerHTML }));
        const renderedHtml = compactSignals.renderedHtml;
        delete compactSignals.renderedHtml;
        signals = { ...initial, ...compactSignals, renderedDomHash: createHash("sha256").update(renderedHtml).digest("hex"), domChanged: Boolean(initial.initialHtmlHash && initial.initialHtmlHash !== createHash("sha256").update(renderedHtml).digest("hex")) };
      }
      rendered.push({ relativePath: `pages/${pageId}/assets/${viewport.name}.png`, bytes: await page.screenshot({ type: "png", fullPage: true }), label: viewport.label });
    } finally { await page.close().catch(() => {}); await context.close().catch(() => {}); }
  }
  const domHash = createHash("sha256").update(JSON.stringify(signals)).digest("hex");
  const nextPage = {
    ...detail.page,
    coverage: detail.page.coverage === "none" ? "partial" : "partial",
    evidence: { ...(detail.page.evidence || {}), dom: true, renderedDom: true, screenshots: true, browser: "chromium", executablePath, domHash, initialHtmlHash: signals.initialHtmlHash, renderedDomHash: signals.renderedDomHash, domChanged: signals.domChanged, initialHtmlBytes: signals.initialHtmlBytes, renderedDomBytes: signals.renderedDomBytes, htmlComparison: { initialHash: signals.initialHtmlHash, renderedHash: signals.renderedDomHash, changed: signals.domChanged }, capturedAt: new Date().toISOString() },
    response: { ...(detail.page.response || {}), renderedDom: true },
    metadata: { ...(detail.page.metadata || {}), ...signals },
    screenshots: rendered.map(({ label, relativePath }) => ({ label, path: relativePath.replace(`pages/${pageId}/assets/`, "") })),
    diagnostics: (detail.page.diagnostics || []).filter((item) => !["deep-browser-evidence-pending", "browser-unavailable", "browser-runtime-unavailable"].includes(item.code)),
  };
  await writeAuditFilesAtomic(auditId, rendered);
  await detailStore.savePageBatch(auditId, [nextPage]);
  const currentRun = await runs.get(auditId);
  await runs.update(auditId, { stage: "render", status: "partial", completedPages: [...new Set([...(currentRun.completedPages || []), pageId])] });
  console.log(JSON.stringify({ auditId, pageId, rendered: true, screenshots: nextPage.screenshots, signals }, null, 2));
} catch (error) {
  const diagnostic = { code: "browser-render-failed", stage: "render", source: "browser", scope: detail.page.url, message: error.message || "Falló el renderizado.", retryable: true, completenessImpact: "La página conserva su cobertura HTTP, pero no la evidencia profunda.", nextAction: "Revisar timeout, TLS o JavaScript de la URL y reintentar." };
  await detailStore.savePageBatch(auditId, [{ ...detail.page, diagnostics: [...(detail.page.diagnostics || []).filter((item) => item.code !== diagnostic.code), diagnostic] }]);
  await runs.update(auditId, { stage: "render", status: "partial", diagnostics: [diagnostic] });
  console.error(JSON.stringify({ auditId, pageId, rendered: false, reason: diagnostic.code, message: error.message }, null, 2));
  process.exitCode = 0;
} finally {
  if (browser) await browser.close().catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
