import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function setup(suffix) {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), `seo-storage-${suffix}-`));
  const stamp = `${Date.now()}-${Math.random()}`;
  const { AuditStore } = await import(`../src/audit-store.mjs?storage=${stamp}`);
  const { measureAuditStorage, writeAuditFilesAtomic, AUDIT_STORAGE_LIMIT_BYTES, AUDIT_STORAGE_LIMIT_LABEL } = await import(`../src/audit-storage.mjs?storage=${stamp}`);
  const store = new AuditStore();
  await store.save({ id: "storage-audit", title: "Storage", project: { slug: "demo", name: "Demo" }, status: "draft", reportMarkdown: "# Demo" });
  return { root: process.env.SEO_PLUGIN_DATA_DIR, store, measureAuditStorage, writeAuditFilesAtomic, AUDIT_STORAGE_LIMIT_BYTES, AUDIT_STORAGE_LIMIT_LABEL };
}

test("mide el snapshot y devuelve desglose y estado", async () => {
  const { measureAuditStorage, AUDIT_STORAGE_LIMIT_LABEL } = await setup("measure");
  const result = await measureAuditStorage("storage-audit");
  assert.ok(result.usedBytes > 0);
  assert.equal(result.limitBytes, 512_000_000);
  assert.equal(result.limitLabel, AUDIT_STORAGE_LIMIT_LABEL);
  assert.equal(result.limitLabel, "512 MB");
  assert.equal(result.status, "normal");
  assert.equal(result.breakdown.report > 0, true);
  assert.equal(result.files >= 3, true);
});

test("rechaza antes de escribir cuando el tamaño proyectado supera 512 MB", async () => {
  const { root, measureAuditStorage, writeAuditFilesAtomic, AUDIT_STORAGE_LIMIT_BYTES } = await setup("quota");
  const auditRoot = join(root, "audits", "storage-audit");
  const current = await measureAuditStorage("storage-audit");
  const filler = join(auditRoot, "filler.bin");
  await writeFile(filler, "");
  await truncate(filler, AUDIT_STORAGE_LIMIT_BYTES - current.usedBytes + 1);
  const before = await readFile(join(auditRoot, "report.md"), "utf8");
  await assert.rejects(writeAuditFilesAtomic("storage-audit", [{ relativePath: "report.md", bytes: "reemplazo" }]), (error) => error.code === "audit-storage-limit-exceeded");
  assert.equal(await readFile(join(auditRoot, "report.md"), "utf8"), before);
  const run = JSON.parse(await readFile(join(root, "runs", "storage-audit.json"), "utf8"));
  assert.equal(run.lastError.code, "audit-storage-limit-exceeded");
});

test("permite que el snapshot llegue exactamente a 512 MB", async () => {
  const { root, measureAuditStorage, writeAuditFilesAtomic, AUDIT_STORAGE_LIMIT_BYTES } = await setup("exact");
  const auditRoot = join(root, "audits", "storage-audit");
  const current = await measureAuditStorage("storage-audit");
  await writeFile(join(auditRoot, "filler.bin"), "");
  await truncate(join(auditRoot, "filler.bin"), AUDIT_STORAGE_LIMIT_BYTES - current.usedBytes);
  const report = await readFile(join(auditRoot, "report.md"));
  await writeAuditFilesAtomic("storage-audit", [{ relativePath: "report.md", bytes: report }]);
  const measured = await measureAuditStorage("storage-audit");
  assert.equal(measured.usedBytes, AUDIT_STORAGE_LIMIT_BYTES);
  assert.equal(measured.status, "limit");
});

test("permite reemplazos sin exceder y bloquea enlaces simbólicos", async () => {
  const { root, measureAuditStorage, writeAuditFilesAtomic } = await setup("safe");
  await writeAuditFilesAtomic("storage-audit", [{ relativePath: "report.md", bytes: "# Actualizado" }]);
  assert.match(await readFile(join(root, "audits", "storage-audit", "report.md"), "utf8"), /Actualizado/);
  await symlink(join(root, "audits", "storage-audit", "report.md"), join(root, "audits", "storage-audit", "bad-link"));
  await assert.rejects(measureAuditStorage("storage-audit"), (error) => error.code === "audit-storage-symlink");
});

test("serializa escrituras concurrentes y recupera un bloqueo abandonado", async () => {
  const { root, writeAuditFilesAtomic } = await setup("lock");
  const lockDir = join(root, ".locks");
  await writeFile(join(lockDir, "storage-audit.storage.lock"), "abandonado");
  const old = new Date(Date.now() - 180_000);
  await utimes(join(lockDir, "storage-audit.storage.lock"), old, old);
  await Promise.all([1, 2, 3].map((index) => writeAuditFilesAtomic("storage-audit", [{ relativePath: `pages/lock-${index}.json`, value: { index } }] )));
  const files = await Promise.all([1, 2, 3].map((index) => readFile(join(root, "audits", "storage-audit", "pages", `lock-${index}.json`), "utf8")));
  assert.deepEqual(files.map((value) => JSON.parse(value).index), [1, 2, 3]);
});
