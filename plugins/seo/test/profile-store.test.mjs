import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "../src/profile-store.mjs";

test("crea varios perfiles y resuelve el predeterminado", async () => {
  const root = await mkdtemp(join(tmpdir(), "seo-profiles-"));
  const store = new ProfileStore({ path: join(root, "profiles.json"), now: () => "2026-09-02T10:00:00.000Z" });
  await store.upsert({ id: "taxiprime", name: "TaxiPrime", services: { searchConsole: { accountEmail: "Admin@TaxiSabadell.online", siteUrl: "sc-domain:taxiprime.app" } }, setDefault: true });
  await store.upsert({ id: "cuatro-mans", name: "4Mans", services: { analytics: { accountEmail: "seo@example.com", property: "properties/123" } } });
  const registry = await store.list();
  assert.equal(registry.profiles.length, 2);
  assert.equal(registry.defaultProfileId, "taxiprime");
  assert.equal((await store.get()).profile.services.searchConsole.accountEmail, "admin@taxisabadell.online");
});

test("eliminar un perfil no revoca credenciales", async () => {
  const root = await mkdtemp(join(tmpdir(), "seo-profiles-"));
  const path = join(root, "profiles.json");
  const store = new ProfileStore({ path });
  await store.upsert({ id: "uno", name: "Uno", setDefault: true });
  const result = await store.remove("uno");
  assert.equal(result.credentialsRevoked, false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).profiles.length, 0);
});

test("rechaza ids que intentan escapar del almacén", async () => {
  const store = new ProfileStore({ path: join(await mkdtemp(join(tmpdir(), "seo-profiles-")), "profiles.json") });
  await assert.rejects(store.upsert({ id: "../fuera", name: "No" }), /guiones/);
});
