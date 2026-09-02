import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("compara snapshots por URL, KPI y salud sin limitarse a las primeras 100 páginas", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-history-"));
  const stamp = `${Date.now()}-${Math.random()}`;
  const { AuditStore } = await import(`../src/audit-store.mjs?history=${stamp}`);
  const { AuditDetailStore } = await import(`../src/audit-detail-store.mjs?history=${stamp}`);
  const { getAuditChanges } = await import(`../src/audit-history.mjs?history=${stamp}`);
  const audits = new AuditStore({ now: () => "2026-09-01T10:00:00.000Z" });
  const details = new AuditDetailStore({ now: () => "2026-09-01T10:00:00.000Z" });
  await audits.save({ id: "history-one", title: "Uno", project: { slug: "demo", name: "Demo" }, status: "draft", kpis: [{ id: "clicks", label: "Clics", value: 10, source: "GSC" }] });
  await details.savePageBatch("history-one", [
    { url: "https://example.com/keep", coverage: "complete", issueCounts: { p1: 1 }, response: { status: 500 }, metadata: { title: "Antiguo" } },
    { url: "https://example.com/remove", coverage: "complete", response: { status: 200 }, metadata: { title: "Retirada" } },
  ]);
  await details.saveFindings("history-one", [{ ruleId: "http-status", severity: "p1", title: "HTTP", explanation: "Error", evidence: "500", impact: "No carga", source: "crawler", affectedUrls: ["https://example.com/keep"], actions: [{ title: "Corregir", why: "Carga", validation: "200" }] }]);
  await audits.save({ id: "history-two", title: "Dos", project: { slug: "demo", name: "Demo" }, status: "draft", kpis: [{ id: "clicks", label: "Clics", value: 20, previousValue: 10, source: "GSC" }] });
  await details.savePageBatch("history-two", [
    { url: "https://example.com/keep", coverage: "complete", response: { status: 200 }, metadata: { title: "Nuevo" } },
    { url: "https://example.com/add", coverage: "complete", response: { status: 200 }, metadata: { title: "Nueva" } },
  ]);
  await details.saveFindings("history-two", []);
  const changes = await getAuditChanges("history-two");
  assert.equal(changes.comparable, true);
  assert.equal(changes.previousAuditId, "history-one");
  assert.equal(changes.pageChanges.find((item) => item.url.endsWith("/keep")).status, "mejorado");
  assert.equal(changes.pageChanges.find((item) => item.url.endsWith("/add")).status, "nuevo");
  assert.equal(changes.pageChanges.find((item) => item.url.endsWith("/remove")).status, "resuelto");
  assert.equal(changes.metricChanges[0].status, "actualizado");
  assert.equal(changes.findingChanges.resolved.length, 1);
});
