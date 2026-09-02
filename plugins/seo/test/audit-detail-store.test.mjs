import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setup(suffix = "") {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), `seo-v3-${suffix}`));
  const stamp = `${Date.now()}-${Math.random()}`;
  const { AuditStore } = await import(`../src/audit-store.mjs?detail=${stamp}`);
  const { AuditDetailStore } = await import(`../src/audit-detail-store.mjs?detail=${stamp}`);
  const audit = new AuditStore({ now: () => "2026-09-02T10:00:00.000Z" });
  await audit.save({ id: "demo-audit", title: "Demo", project: { slug: "demo", name: "Demo" }, status: "draft" });
  return { audit, detail: new AuditDetailStore({ now: () => "2026-09-02T10:05:00.000Z" }) };
}

const action = { title: "Corregir respuesta", why: "Evita perder rastreo e indexación.", steps: ["Publicar una respuesta 200."], validation: "La URL responde 200 y es indexable.", ownerRole: "Desarrollo", effort: "s" };
const finding = { ruleId: "http-status", scope: "page", severity: "p1", category: "technical", title: "La URL responde con error", explanation: "El robot no puede obtener el documento.", evidence: "Respuesta HTTP 500 observada durante el rastreo.", impact: "La página no puede posicionarse.", affectedUrls: ["https://example.com/error/"], source: "crawler", actions: [action] };

test("genera ids estables a partir de la URL canónica normalizada", async () => {
  const { normalizePageUrl, pageIdForUrl } = await import(`../src/audit-detail-store.mjs?url=${Date.now()}`);
  assert.equal(normalizePageUrl("HTTPS://EXAMPLE.COM/a//?b=2&a=1#x"), "https://example.com/a?a=1&b=2");
  assert.equal(pageIdForUrl("https://example.com/a/"), pageIdForUrl("https://EXAMPLE.com/a"));
  assert.throws(() => pageIdForUrl("file:///etc/passwd"), /HTTP/);
});

test("guarda hallazgos, inventario y páginas filtrables sin degradar un snapshot v5", async () => {
  const { detail } = await setup("save-");
  const savedFindings = await detail.saveFindings("demo-audit", [finding]);
  await detail.saveInventory("demo-audit", { sitemaps: [{ url: "https://example.com/sitemap.xml", status: 200 }], robots: { status: 200 } }, [{ code: "ga4-unavailable", source: "google-analytics", message: "OAuth pendiente.", completenessImpact: "No hay tráfico ni conversiones.", nextAction: "Conectar GA4 y repetir la fase de datos.", retryable: true }]);
  const result = await detail.savePageBatch("demo-audit", [{ url: "https://example.com/error/", canonicalUrl: "https://example.com/error", discoverySources: ["sitemap"], sitemapUrls: ["https://example.com/sitemap.xml"], template: "landing", locale: "es", auditLevel: "deep", coverage: "complete", issueCounts: { p1: 1 }, findingIds: [savedFindings.findings[0].id], response: { status: 500 }, indexability: { indexable: false }, metadata: { title: "Error" } }]);
  assert.deepEqual(result, { saved: 1, total: 1, deepCount: 1 });
  const listed = await detail.listPages("demo-audit", { health: "issues", template: "landing" });
  assert.equal(listed.total, 1);
  const page = await detail.getPage("demo-audit", listed.pages[0].id);
  assert.equal(page.page.response.status, 500);
  assert.equal(page.findings[0].workflow.status, "pending");
  const manifest = JSON.parse(await readFile(join(process.env.SEO_PLUGIN_DATA_DIR, "audits", "demo-audit", "manifest.json")));
  assert.equal(manifest.version, 5);
  assert.equal(manifest.content.pages.deepCount, 1);
  assert.equal(manifest.content.findings.count, 1);
});

test("impone batch, duplicados canónicos y acciones concretas", async () => {
  const { detail } = await setup("limits-");
  await assert.rejects(detail.savePageBatch("demo-audit", Array.from({ length: 26 }, (_, index) => ({ url: `https://example.com/${index}` }))), /1 y 25/);
  await assert.rejects(detail.savePageBatch("demo-audit", [{ url: "https://example.com/a/" }, { url: "https://example.com/a" }]), /duplicadas/);
  await assert.rejects(detail.saveFindings("demo-audit", [{ ...finding, actions: [] }]), /al menos una acción/);
});

test("limita la auditoría a 50 páginas profundas antes de escribir el lote inválido", async () => {
  const { detail } = await setup("deep-limit-");
  const make = (start, count) => Array.from({ length: count }, (_, index) => ({ url: `https://example.com/deep-${start + index}`, auditLevel: "deep", coverage: "partial" }));
  await detail.savePageBatch("demo-audit", make(0, 25));
  await detail.savePageBatch("demo-audit", make(25, 25));
  await assert.rejects(detail.savePageBatch("demo-audit", make(50, 1)), /50 páginas profundas/);
  assert.equal((await detail.listPages("demo-audit", { limit: 100 })).total, 50);
});

test("mantiene el tracker fuera del snapshot, verifica y reabre incidencias", async () => {
  const { audit, detail } = await setup("workflow-");
  const first = await detail.saveFindings("demo-audit", [finding]);
  const fingerprint = first.findings[0].fingerprint;
  await detail.manageWorkflow({ action: "update", projectId: "demo", fingerprint, status: "resolved", owner: "Ana", note: "Desplegado" });
  await detail.saveFindings("demo-audit", [finding]);
  assert.equal((await detail.listIssues("demo")).issues[0].status, "resolved");
  assert.equal((await detail.listIssues("demo")).issues[0].verification, "awaiting_verification");
  await audit.save({ id: "demo-audit-two", title: "Segundo snapshot", project: { slug: "demo", name: "Demo" }, status: "draft" });
  await detail.saveFindings("demo-audit-two", [finding]);
  assert.equal((await detail.listIssues("demo")).issues[0].status, "pending");
  assert.equal((await detail.listIssues("demo")).issues[0].verification, "reopened");
  await detail.manageWorkflow({ action: "update", projectId: "demo", fingerprint, status: "accepted", acceptanceReason: "Dependencia externa hasta octubre" });
  await detail.saveFindings("demo-audit-two", []);
  const accepted = (await detail.listIssues("demo")).issues[0];
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.detected, false);
  await audit.save({ id: "demo-audit", title: "Demo final", project: { slug: "demo", name: "Demo" }, status: "completed" });
  await assert.rejects(detail.saveInventory("demo-audit", {}), /inmutable/);
  const updated = await detail.manageWorkflow({ action: "update", projectId: "demo", fingerprint, status: "in_progress" });
  assert.equal(updated.status, "in_progress");
});
