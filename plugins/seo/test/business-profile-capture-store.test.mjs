import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { AuditStore } from "../src/audit-store.mjs";
import { BusinessProfileCaptureStore, BUSINESS_PROFILE_CACHE_TTL_MS, BUSINESS_PROFILE_CAPTURE_LIMIT_BYTES, businessProfileMetrics } from "../src/business-profile-capture-store.mjs";
import { insideDataRoot } from "../src/data-root.mjs";

const baseInput = {
  profileId: "demo", accountName: "accounts/123", locationName: "locations/456", status: "available",
  coverage: { location: { status: "available" }, media: { status: "available" }, reviews: { status: "available" }, posts: { status: "available" }, performance: { status: "partial", detail: "90 días" } },
  location: { title: "Demo", websiteUri: "https://example.com", phoneNumbers: { primaryPhone: "+34 600 000 000" } },
  reviewSummary: { averageRating: 4.8, totalReviewCount: 10 },
  reviews: [{ reviewId: "r1", reviewer: { displayName: "Ana" }, starRating: "FIVE", comment: "Muy bien" }],
  posts: [{ name: "posts/1", summary: "Novedad", state: "LIVE" }],
  performance: { startDate: "2026-08-31", endDate: "2026-09-02", series: [{ key: "website-clicks", label: "Clics web", color: "lime", points: [{ date: "2026-08-31", value: 2 }, { date: "2026-09-02", value: 5 }] }] },
};

async function setup() {
  process.env.SEO_PLUGIN_DATA_DIR = await mkdtemp(join(tmpdir(), "seo-gbp-cache-"));
  await new AuditStore().save({ id: "audit-demo", title: "Demo", project: { slug: "demo", name: "Demo" }, profileId: "demo", status: "draft" });
}

test("guarda miniaturas privadas, enlaza v5 y conserva límites", async () => {
  await setup();
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#112233" } }).png().toBuffer();
  const store = new BusinessProfileCaptureStore({ now: () => "2026-09-02T10:00:00.000Z", fetchImpl: async () => new Response(image, { headers: { "content-type": "image/png" } }) });
  const saved = await store.save({ ...baseInput, media: [{ id: "cover", category: "COVER", thumbnailUrl: "https://lh3.googleusercontent.com/demo" }] });
  await new AuditStore().attachBusinessProfileCapture("audit-demo", saved.reference);
  assert.equal(saved.reference.expiresAt, "2026-10-02T10:00:00.000Z");
  assert.equal((await new AuditStore().get("audit-demo")).manifest.version, 5);
  const loaded = await store.get(saved.reference);
  assert.equal(loaded.capture.media[0].assetId, "cover");
  assert.ok((await store.readAsset(saved.reference, "cover")).length > 0);
  const temporaryMetrics = businessProfileMetrics(loaded, "audit-demo");
  assert.equal(temporaryMetrics.datasets[0].rows.length, 3);
  assert.equal(temporaryMetrics.datasets[0].rows[1].values["website-clicks"], null);
  assert.equal(temporaryMetrics.charts[0].section, "local");
  assert.match(temporaryMetrics.charts[0].csvPath, /business-profile\/performance\.csv$/);
  assert.equal(BUSINESS_PROFILE_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(BUSINESS_PROFILE_CAPTURE_LIMIT_BYTES, 64_000_000);
});

test("caduca sin servir contenido y mantiene aisladas otras ubicaciones", async () => {
  await setup();
  let now = "2026-09-02T10:00:00.000Z";
  const store = new BusinessProfileCaptureStore({ now: () => now, fetchImpl: async () => { throw new Error("no debería descargar"); } });
  const first = await store.save(baseInput);
  const second = await store.save({ ...baseInput, profileId: "otro", locationName: "locations/999" });
  assert.equal((await store.get(first.reference)).status, "available");
  assert.equal((await store.get(second.reference)).status, "available");
  now = "2026-10-03T10:00:00.000Z";
  assert.equal((await store.get(first.reference)).status, "expired");
  await assert.rejects(store.readAsset(first.reference, "cover"), /caducado|disponible/);
});

test("no descarga dominios externos y rechaza symlinks dentro de la captura", async () => {
  await setup();
  let requested = false;
  const store = new BusinessProfileCaptureStore({ now: () => "2026-09-02T10:00:00.000Z", fetchImpl: async () => { requested = true; throw new Error("no permitido"); } });
  const saved = await store.save({ ...baseInput, media: [{ id: "outside", category: "EXTERIOR", thumbnailUrl: "https://example.com/photo.jpg" }] });
  assert.equal(requested, false);
  assert.equal(saved.capture.media[0].assetId, null);
  assert.equal(saved.capture.diagnostics[0].code, "business-profile-media-download-failed");
  const locationHash = createHash("sha256").update(saved.reference.locationName).digest("hex").slice(0, 20);
  const captureRoot = join(insideDataRoot("cache", "business-profile", "demo"), locationHash, saved.reference.captureId);
  await symlink("/tmp", join(captureRoot, "unsafe-link"));
  await assert.rejects(store.get(saved.reference), /enlaces simbólicos/);
});

test("no permite enlazar una captura de otro perfil ni modificar un snapshot completado", async () => {
  await setup();
  const store = new BusinessProfileCaptureStore({ now: () => "2026-09-02T10:00:00.000Z" });
  const other = await store.save({ ...baseInput, profileId: "otro" });
  await assert.rejects(new AuditStore().attachBusinessProfileCapture("audit-demo", other.reference), /otro perfil/);
  await new AuditStore().save({ id: "audit-demo", title: "Demo", project: { slug: "demo", name: "Demo" }, profileId: "demo", status: "completed" });
  const own = await store.save(baseInput);
  await assert.rejects(new AuditStore().attachBusinessProfileCapture("audit-demo", own.reference), /inmutable/);
});
