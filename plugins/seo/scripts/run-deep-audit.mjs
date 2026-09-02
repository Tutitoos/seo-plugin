#!/usr/bin/env node
import { spawn } from "node:child_process";
import { AuditDetailStore } from "../src/audit-detail-store.mjs";
import { AuditRunStore } from "../src/run-status.mjs";
import { ProjectSettingsStore } from "../src/project-settings-store.mjs";
import { safeId } from "../src/data-root.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((item) => { const [key, ...rest] = item.replace(/^--/, "").split("="); return [key, rest.join("=") || true]; }));
if (!args.audit) throw new Error("Uso: node scripts/run-deep-audit.mjs --audit=<id> [--lighthouse=10]");
const auditId = safeId(args.audit, "auditId"), detailStore = new AuditDetailStore(), runs = new AuditRunStore(), settings = new ProjectSettingsStore();
const auditManifest = await detailStore.manifest(auditId), projectConfig = await settings.resolved(auditManifest.project.slug);
const pages = [];
for (let offset = 0; ; offset += 100) {
  const result = await detailStore.listPages(auditId, { offset, limit: 100 });
  pages.push(...result.pages.filter((page) => page.auditLevel === "deep"));
  if (pages.length >= result.total || result.pages.length === 0) break;
}
const weight = (page) => (page.health === "critical" ? 1000 : page.health === "issues" ? 300 : 0) + Number(page.clicks || 0) * 2 + Number(page.impressions || 0) / 100 + (page.template === "landing" ? 50 : 0);
pages.sort((a, b) => weight(b) - weight(a) || a.url.localeCompare(b.url));
pages.splice(50);
const budget = projectConfig.lighthouseBudget || { maxPages: 10, maxRepeats: 3 };
const requestedLighthouse = args.lighthouse === undefined ? budget.maxPages : Number(args.lighthouse);
const lighthousePages = pages.slice(0, Math.max(0, Math.min(10, budget.maxPages, Number.isFinite(requestedLighthouse) ? requestedLighthouse : budget.maxPages)));
const script = (name, page, extra = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [`${new URL(`./${name}`, import.meta.url).pathname}`, `--audit=${auditId}`, `--page=${page.id}`, ...extra], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk.toString(); }); child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.on("close", (code) => resolve({ code, stderr }));
});

const previousRun = await runs.get(auditId);
await runs.update(auditId, { stage: "render", status: "running", totalPages: pages.length, completedPages: previousRun.completedPages || [] });
for (let index = 0; index < pages.length; index += 1) {
  const progress = await runs.get(auditId);
  if (progress.completedPages?.includes(pages[index].id)) continue;
  const result = await script("render-page-evidence.mjs", pages[index]);
  if (result.code !== 0) await runs.update(auditId, { status: "partial", lastError: result.stderr.slice(-1200) });
  if ((index + 1) % 5 === 0 || index + 1 === pages.length) console.error(`Renderizado ${index + 1}/${pages.length}`);
}

const lighthouseRun = await runs.get(auditId);
await runs.update(auditId, { stage: "lighthouse", status: "running", lighthouseTargets: lighthousePages.map((page) => page.id), lighthousePages: lighthouseRun.lighthousePages || [] });
for (let index = 0; index < lighthousePages.length; index += 1) {
  const progress = await runs.get(auditId);
  if (progress.lighthousePages?.includes(lighthousePages[index].id)) continue;
  const repeats = index < 3 ? Math.min(3, budget.maxRepeats || 3) : 1;
  const result = await script("run-lighthouse-page.mjs", lighthousePages[index], [`--repeats=${repeats}`]);
  if (result.code !== 0) await runs.update(auditId, { status: "partial", lastError: result.stderr.slice(-1200) });
  console.error(`Lighthouse ${index + 1}/${lighthousePages.length}`);
}
const current = await runs.get(auditId);
const finalFailed = current.status === "failed";
await runs.update(auditId, { stage: finalFailed ? "failed" : "complete", status: finalFailed ? "failed" : "complete", completedAt: new Date().toISOString(), renderedCount: current.completedPages?.length || 0, lighthouseCount: current.lighthousePages?.length || 0 });
console.log(JSON.stringify({ auditId, pages: pages.length, lighthousePages: lighthousePages.length, renderedCount: current.completedPages?.length || 0, lighthouseCount: current.lighthousePages?.length || 0, status: finalFailed ? "failed" : "complete" }, null, 2));
