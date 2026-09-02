import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectSettingsStore } from "../src/project-settings-store.mjs";

test("aplica objetivos SEO predeterminados y permite sobrescribirlos", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "seo-projects-")), "projects.json");
  const store = new ProjectSettingsStore({ path, now: () => "2026-09-02T10:00:00.000Z" });
  assert.deepEqual((await store.resolved("taxiprime")).targets["mobile-lcp"], { operator: "lte", value: 2.5, warningValue: 4 });
  const saved = await store.upsert({ id: "taxiprime", timezone: "Europe/Madrid", currency: "eur", targets: { "mobile-lcp": { operator: "lte", value: 2.2, warningValue: 3.5 } } });
  assert.equal(saved.currency, "EUR");
  assert.equal(saved.targets["mobile-lcp"].value, 2.2);
});

test("rechaza zonas horarias y objetivos inválidos", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "seo-projects-")), "projects.json");
  const store = new ProjectSettingsStore({ path });
  await assert.rejects(store.upsert({ id: "demo", timezone: "Mars/Olympus" }), /Timezone/);
  await assert.rejects(store.upsert({ id: "demo", targets: { score: { operator: "wat", value: 1 } } }), /Objetivo/);
});
