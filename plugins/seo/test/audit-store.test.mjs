import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("guarda, filtra y recupera una auditoría privada", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}`);
  const store = new AuditStore();
  const saved = await store.save({ id: "audit-one", title: "Auditoría técnica", project: { slug: "taxiprime", name: "TaxiPrime" }, profileId: "taxiprime", auditType: "seo-audit", status: "completed", score: 91, summary: "Sin bloqueos críticos", skillsUsed: ["seo-audit"], tags: ["production"], reportMarkdown: "# Resultado\nCorrecto." });
  assert.equal(saved.score, 91);
  assert.equal((await store.list({ project: "taxiprime" })).length, 1);
  assert.match((await store.get("audit-one")).reportMarkdown, /Resultado/);
  const mode = (await stat(join(process.env.SEO_PLUGIN_DATA_DIR, "audits", "audit-one", "manifest.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("rechaza traversal en identificadores de auditoría", async () => {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-audits-"));
  const { AuditStore } = await import(`../src/audit-store.mjs?test=${Date.now()}x`);
  await assert.rejects(new AuditStore().save({ id: "../../escape", title: "No", project: { slug: "x", name: "X" } }), /guiones/);
});
