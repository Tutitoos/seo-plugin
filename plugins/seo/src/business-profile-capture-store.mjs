import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import sharp from "sharp";
import { ensureDataRoot, insideDataRoot, safeId } from "./data-root.mjs";
import { readJson } from "./json-file.mjs";

export const BUSINESS_PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BUSINESS_PROFILE_CAPTURE_LIMIT_BYTES = 64_000_000;
export const BUSINESS_PROFILE_MEDIA_LIMIT = 40;
export const BUSINESS_PROFILE_REVIEW_LIMIT = 20;
export const BUSINESS_PROFILE_POST_LIMIT = 20;

const GOOGLE_IMAGE_HOSTS = ["googleusercontent.com", "ggpht.com", "googleapis.com", "google.com"];
const COVERAGE = new Set(["available", "partial", "unavailable"]);
const CAPTURE_STATUSES = new Set(["available", "partial", "unavailable"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERFORMANCE_COLORS = ["lime", "blue", "orange", "green", "red", "ink"];

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requiredText(value, label, max = 160) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} es obligatorio.`);
  if (result.length > max) throw new Error(`${label} supera ${max} caracteres.`);
  return result;
}

function optionalText(value, label, max = 5000) {
  if (value == null) return null;
  const result = String(value).trim();
  if (result.length > max) throw new Error(`${label} supera ${max} caracteres.`);
  return result || null;
}

function googleResource(value, prefix, label) {
  const result = requiredText(value, label, 120);
  if (!new RegExp(`^${prefix}\\/\\d+$`).test(result)) throw new Error(`${label} debe usar ${prefix}/{id}.`);
  return result;
}

function iso(value, label) {
  const result = requiredText(value, label, 40);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} debe ser una fecha ISO válida.`);
  return new Date(result).toISOString();
}

function safeUrl(value, { image = false, tel = false } = {}) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (tel && url.protocol === "tel:") return url.toString();
    if (url.protocol !== "https:") return null;
    if (image && !GOOGLE_IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.toString();
  } catch { return null; }
}

function compact(value, label, depth = 0) {
  if (depth > 8) throw new Error(`${label} supera la profundidad permitida.`);
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contiene un número no finito.`);
    return value;
  }
  if (typeof value === "string") return optionalText(value, label, 12_000) || "";
  if (Array.isArray(value)) {
    if (value.length > 250) throw new Error(`${label} supera 250 elementos.`);
    return value.map((item, index) => compact(item, `${label}[${index}]`, depth + 1));
  }
  if (typeof value !== "object") throw new Error(`${label} contiene un valor no admitido.`);
  const entries = Object.entries(value);
  if (entries.length > 250) throw new Error(`${label} supera 250 campos.`);
  const output = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${label} contiene una clave no válida.`);
    output[key] = compact(item, `${label}.${key}`, depth + 1);
  }
  return output;
}

function cleanCoverage(value = {}) {
  return Object.fromEntries(["location", "media", "reviews", "posts", "performance"].map((key) => {
    const status = COVERAGE.has(value[key]?.status) ? value[key].status : "unavailable";
    return [key, { status, detail: optionalText(value[key]?.detail, `coverage.${key}.detail`, 240) }];
  }));
}

function cleanDiagnostics(value = []) {
  if (!Array.isArray(value) || value.length > 50) throw new Error("diagnostics admite como máximo 50 elementos.");
  return value.map((item, index) => ({
    code: safeId(item.code || "business-profile-unknown", `diagnostics[${index}].code`),
    stage: optionalText(item.stage, `diagnostics[${index}].stage`, 80),
    message: requiredText(item.message, `diagnostics[${index}].message`, 800),
    retryable: Boolean(item.retryable),
    nextAction: optionalText(item.nextAction, `diagnostics[${index}].nextAction`, 800),
    attemptedAt: item.attemptedAt ? iso(item.attemptedAt, `diagnostics[${index}].attemptedAt`) : null,
  }));
}

function cleanMedia(value = []) {
  if (!Array.isArray(value)) throw new Error("media debe ser un array.");
  return value.slice(0, BUSINESS_PROFILE_MEDIA_LIMIT).map((item, index) => {
    const candidateUrl = item.thumbnailUrl || item.googleUrl || null;
    const thumbnailUrl = safeUrl(candidateUrl, { image: true });
    return ({
    id: (() => { try { return safeId(item.id || `media-${index + 1}`, `media[${index}].id`); } catch { return `media-${createHash("sha256").update(`${item.name || item.thumbnailUrl || index}`).digest("hex").slice(0, 16)}-${index + 1}`; } })(),
    name: optionalText(item.name, `media[${index}].name`, 180),
    source: item.source === "customer" ? "customer" : "owner",
    category: optionalText(item.category || item.locationAssociation?.category, `media[${index}].category`, 60) || "ADDITIONAL",
    description: optionalText(item.description, `media[${index}].description`, 600),
    createTime: item.createTime ? iso(item.createTime, `media[${index}].createTime`) : null,
    widthPixels: Number.isFinite(item.dimensions?.widthPixels ?? item.widthPixels) ? Number(item.dimensions?.widthPixels ?? item.widthPixels) : null,
    heightPixels: Number.isFinite(item.dimensions?.heightPixels ?? item.heightPixels) ? Number(item.dimensions?.heightPixels ?? item.heightPixels) : null,
    viewCount: Number.isFinite(Number(item.insights?.viewCount ?? item.viewCount)) ? Number(item.insights?.viewCount ?? item.viewCount) : null,
    thumbnailUrl,
    thumbnailRejected: Boolean(candidateUrl && !thumbnailUrl),
  }); });
}

function cleanReviews(value = []) {
  if (!Array.isArray(value)) throw new Error("reviews debe ser un array.");
  return value.slice(0, BUSINESS_PROFILE_REVIEW_LIMIT).map((item, index) => ({
    reviewId: optionalText(item.reviewId || item.name, `reviews[${index}].reviewId`, 180),
    reviewer: { displayName: optionalText(item.reviewer?.displayName, `reviews[${index}].reviewer.displayName`, 120), isAnonymous: Boolean(item.reviewer?.isAnonymous) },
    starRating: optionalText(item.starRating, `reviews[${index}].starRating`, 30),
    comment: optionalText(item.comment, `reviews[${index}].comment`, 6000),
    createTime: item.createTime ? iso(item.createTime, `reviews[${index}].createTime`) : null,
    updateTime: item.updateTime ? iso(item.updateTime, `reviews[${index}].updateTime`) : null,
    reviewReply: item.reviewReply ? { comment: optionalText(item.reviewReply.comment, `reviews[${index}].reviewReply.comment`, 6000), updateTime: item.reviewReply.updateTime ? iso(item.reviewReply.updateTime, `reviews[${index}].reviewReply.updateTime`) : null } : null,
  }));
}

function cleanPosts(value = []) {
  if (!Array.isArray(value)) throw new Error("posts debe ser un array.");
  return value.slice(0, BUSINESS_PROFILE_POST_LIMIT).map((item, index) => ({
    name: optionalText(item.name, `posts[${index}].name`, 180),
    summary: optionalText(item.summary, `posts[${index}].summary`, 3000),
    topicType: optionalText(item.topicType, `posts[${index}].topicType`, 40),
    state: optionalText(item.state, `posts[${index}].state`, 40),
    createTime: item.createTime ? iso(item.createTime, `posts[${index}].createTime`) : null,
    updateTime: item.updateTime ? iso(item.updateTime, `posts[${index}].updateTime`) : null,
    searchUrl: safeUrl(item.searchUrl),
    callToAction: item.callToAction ? compact(item.callToAction, `posts[${index}].callToAction`) : null,
    event: item.event ? compact(item.event, `posts[${index}].event`) : null,
    offer: item.offer ? compact(item.offer, `posts[${index}].offer`) : null,
    media: Array.isArray(item.media) ? item.media.slice(0, 4).map((media, mediaIndex) => ({ mediaFormat: optionalText(media.mediaFormat, `posts[${index}].media[${mediaIndex}].mediaFormat`, 30), googleUrl: safeUrl(media.googleUrl || media.sourceUrl, { image: true }) })) : [],
  }));
}

function cleanPerformance(value = {}) {
  if (!value || !Object.keys(value).length) return { startDate: null, endDate: null, series: [] };
  const startDate = requiredText(value.startDate, "performance.startDate", 10);
  const endDate = requiredText(value.endDate, "performance.endDate", 10);
  if (!DATE.test(startDate) || !DATE.test(endDate) || startDate > endDate) throw new Error("performance requiere fechas ISO ordenadas.");
  if ((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 >= 366) throw new Error("performance no puede superar 366 días.");
  if (!Array.isArray(value.series) || value.series.length > 11) throw new Error("performance.series admite como máximo 11 series.");
  const series = value.series.map((item, index) => {
    const key = safeId(item.key, `performance.series[${index}].key`);
    if (!Array.isArray(item.points) || item.points.length > 366) throw new Error(`performance.series[${index}].points admite como máximo 366 días.`);
    const seen = new Set();
    const points = item.points.map((point, pointIndex) => {
      if (!DATE.test(point.date) || point.date < startDate || point.date > endDate || seen.has(point.date)) throw new Error(`performance.series[${index}].points[${pointIndex}] contiene una fecha inválida o duplicada.`);
      seen.add(point.date);
      const number = point.value == null ? null : Number(point.value);
      if (number != null && !Number.isFinite(number)) throw new Error(`performance.series[${index}].points[${pointIndex}].value debe ser finito o null.`);
      return { date: point.date, value: number };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return { key, label: requiredText(item.label, `performance.series[${index}].label`, 80), unit: optionalText(item.unit, `performance.series[${index}].unit`, 24) || "", color: PERFORMANCE_COLORS.includes(item.color) ? item.color : PERFORMANCE_COLORS[index % PERFORMANCE_COLORS.length], points };
  });
  if (new Set(series.map((item) => item.key)).size !== series.length) throw new Error("performance.series contiene claves duplicadas.");
  return { startDate, endDate, series };
}

export function businessProfileMetrics(state, auditId) {
  const performance = state?.capture?.performance;
  if (!performance?.series?.length) return { datasets: [], charts: [] };
  const dates = [];
  for (let cursor = new Date(`${performance.startDate}T00:00:00Z`), end = new Date(`${performance.endDate}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10));
  const dataset = {
    id: "business-profile-performance", type: "timeseries", title: "Rendimiento local", source: "Google Business Profile · captura temporal", granularity: "day",
    series: performance.series.map(({ key, label, unit, color }) => ({ key, label, unit, color, axis: "left", aggregation: "sum", weightKey: null })),
    rows: dates.map((date) => ({ date, values: Object.fromEntries(performance.series.map((series) => [series.key, series.points.find((point) => point.date === date)?.value ?? null])) })),
  };
  return { datasets: [dataset], charts: [{ id: "business-profile-performance", title: "Interacciones desde Google", type: "area", description: "Evolución temporal disponible para la ficha seleccionada. Los huecos se mantienen como datos ausentes.", section: "local", engine: "echarts", datasetId: dataset.id, seriesKeys: dataset.series.map((series) => series.key), compareMode: "none", annotations: [], csvPath: `/api/audits/${safeId(auditId, "auditId")}/business-profile/performance.csv` }] };
}

function locationHash(locationName) {
  return createHash("sha256").update(locationName).digest("hex").slice(0, 20);
}

function cacheRoot(profileId, locationName) {
  return insideDataRoot("cache", "business-profile", safeId(profileId, "profileId"), locationHash(locationName));
}

function captureRoot(reference) {
  return resolve(cacheRoot(reference.profileId, reference.locationName), safeId(reference.captureId, "captureId"));
}

function insideCapture(reference, ...parts) {
  const root = captureRoot(reference);
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("La ruta solicitada está fuera de la captura.");
  return target;
}

async function directorySize(root, current = root) {
  let bytes = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw codedError("business-profile-cache-symlink", "No se permiten enlaces simbólicos en la caché de Business Profile.");
    if (info.isDirectory()) bytes += await directorySize(root, path);
    else if (info.isFile()) bytes += info.size;
  }
  return bytes;
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
}

async function withCaptureLock(profileId, locationName, callback) {
  const locks = insideDataRoot(".locks");
  const lock = resolve(locks, `business-profile-${safeId(profileId, "profileId")}-${locationHash(locationName)}.lock`);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try { const info = await lstat(lock); if (Date.now() - info.mtimeMs > 120_000) await rm(lock, { recursive: true, force: true }); }
      catch (readError) { if (readError?.code !== "ENOENT") throw readError; }
      if (Date.now() - started > 15_000) throw codedError("business-profile-cache-lock-timeout", "No se pudo bloquear la captura de Business Profile para escribir.");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  try { return await callback(); }
  finally { await rm(lock, { recursive: true, force: true }).catch(() => {}); }
}

async function fetchThumbnail(url, fetchImpl) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    let target = url;
    let response;
    for (let redirect = 0; redirect < 4; redirect += 1) {
      if (!safeUrl(target, { image: true })) throw new Error("dominio de imagen no permitido");
      response = await fetchImpl(target, { signal: controller.signal, redirect: "manual", headers: { Accept: "image/*" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("redirección sin destino");
      target = new URL(location, target).toString();
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("demasiadas redirecciones");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 8_000_000) throw new Error("imagen superior a 8 MB");
    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > 8_000_000) throw new Error("imagen superior a 8 MB");
    const output = await sharp(input, { failOn: "error" }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    if (output.length > 2_000_000) throw new Error("miniatura superior a 2 MB");
    return output;
  } finally { clearTimeout(timeout); }
}

export function normalizeBusinessProfileReference(value) {
  if (!value) return null;
  const capturedAt = iso(value.capturedAt, "businessProfileCapture.capturedAt");
  const expiresAt = iso(value.expiresAt, "businessProfileCapture.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(capturedAt) || Date.parse(expiresAt) - Date.parse(capturedAt) > BUSINESS_PROFILE_CACHE_TTL_MS) throw new Error("La captura de Business Profile no puede conservarse más de 30 días.");
  return {
    captureId: safeId(value.captureId, "businessProfileCapture.captureId"),
    profileId: safeId(value.profileId, "businessProfileCapture.profileId"),
    accountName: googleResource(value.accountName, "accounts", "businessProfileCapture.accountName"),
    locationName: googleResource(value.locationName, "locations", "businessProfileCapture.locationName"),
    capturedAt, expiresAt,
    status: CAPTURE_STATUSES.has(value.status) ? value.status : "partial",
    coverage: cleanCoverage(value.coverage),
    diagnosticsCount: Number.isInteger(value.diagnosticsCount) && value.diagnosticsCount >= 0 ? value.diagnosticsCount : 0,
    truncated: { media: Boolean(value.truncated?.media), reviews: Boolean(value.truncated?.reviews), posts: Boolean(value.truncated?.posts) },
  };
}

export class BusinessProfileCaptureStore {
  constructor({ now = () => new Date().toISOString(), fetchImpl = globalThis.fetch } = {}) { this.now = now; this.fetchImpl = fetchImpl; }

  async pruneExpired() {
    await ensureDataRoot();
    const root = insideDataRoot("cache", "business-profile");
    let profiles = [];
    try { profiles = await readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return { removed: 0 }; throw error; }
    let removed = 0;
    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      for (const location of await readdir(resolve(root, profile.name), { withFileTypes: true })) {
        if (!location.isDirectory()) continue;
        for (const capture of await readdir(resolve(root, profile.name, location.name), { withFileTypes: true })) {
          if (!capture.isDirectory()) continue;
          const folder = resolve(root, profile.name, location.name, capture.name);
          const data = await readJson(resolve(folder, "capture.json"), null).catch(() => null);
          if (!data || Date.parse(data.reference?.expiresAt || 0) <= Date.parse(this.now())) { await rm(folder, { recursive: true, force: true }); removed += 1; }
        }
      }
    }
    return { removed };
  }

  async save(input) {
    await ensureDataRoot();
    await this.pruneExpired();
    const profileId = safeId(input.profileId, "profileId");
    const accountName = googleResource(input.accountName, "accounts", "accountName");
    const locationName = googleResource(input.locationName, "locations", "locationName");
    return withCaptureLock(profileId, locationName, async () => {
    const capturedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(Date.parse(capturedAt) + BUSINESS_PROFILE_CACHE_TTL_MS).toISOString();
    const captureId = `${profileId}-${locationHash(locationName).slice(0, 8)}-${capturedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const reference = normalizeBusinessProfileReference({ captureId, profileId, accountName, locationName, capturedAt, expiresAt, status: input.status, coverage: input.coverage, diagnosticsCount: input.diagnostics?.length || 0, truncated: { media: (input.media?.length || 0) > BUSINESS_PROFILE_MEDIA_LIMIT, reviews: (input.reviews?.length || 0) > BUSINESS_PROFILE_REVIEW_LIMIT, posts: (input.posts?.length || 0) > BUSINESS_PROFILE_POST_LIMIT } });
    const root = captureRoot(reference);
    const staging = `${root}.${randomUUID()}.tmp`;
    const media = cleanMedia(input.media);
    const diagnostics = cleanDiagnostics(input.diagnostics);
    const savedMedia = [];
    try {
      await mkdir(resolve(staging, "assets"), { recursive: true, mode: 0o700 });
      for (const item of media) {
        let assetId = null;
        if (item.thumbnailRejected) diagnostics.push({ code: "business-profile-media-download-failed", stage: "media", message: `No se descargó la miniatura ${item.id}: dominio o protocolo no permitido.`, retryable: false, nextAction: "Usa únicamente las URLs HTTPS devueltas por Google Business Profile.", attemptedAt: capturedAt });
        if (item.thumbnailUrl) {
          try {
            const bytes = await fetchThumbnail(item.thumbnailUrl, this.fetchImpl);
            if (bytes) {
              assetId = item.id;
              await atomicWrite(resolve(staging, "assets", `${assetId}.webp`), bytes);
            }
          } catch (error) {
            diagnostics.push({ code: "business-profile-media-download-failed", stage: "media", message: `No se pudo conservar la miniatura ${item.id}: ${error.message}`, retryable: true, nextAction: "Vuelve a ejecutar /seo full mientras la URL de Google siga vigente.", attemptedAt: capturedAt });
          }
        }
        const { thumbnailRejected, ...metadata } = item;
        savedMedia.push({ ...metadata, thumbnailUrl: null, assetId });
      }
      const capture = {
        version: 1,
        reference: { ...reference, diagnosticsCount: diagnostics.length },
        location: compact(input.location || {}, "location"),
        attributes: compact(input.attributes || [], "attributes"),
        reviewSummary: { averageRating: Number.isFinite(Number(input.reviewSummary?.averageRating)) ? Number(input.reviewSummary.averageRating) : null, totalReviewCount: Number.isFinite(Number(input.reviewSummary?.totalReviewCount)) ? Number(input.reviewSummary.totalReviewCount) : null },
        media: savedMedia,
        reviews: cleanReviews(input.reviews),
        posts: cleanPosts(input.posts),
        performance: cleanPerformance(input.performance),
        diagnostics,
      };
      await atomicWrite(resolve(staging, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
      const bytes = await directorySize(staging);
      if (bytes > BUSINESS_PROFILE_CAPTURE_LIMIT_BYTES) throw codedError("business-profile-cache-limit-exceeded", "La captura de Business Profile supera el límite de 64 MB.", { usedBytes: bytes, limitBytes: BUSINESS_PROFILE_CAPTURE_LIMIT_BYTES });
      await mkdir(dirname(root), { recursive: true, mode: 0o700 });
      await rm(root, { recursive: true, force: true });
      await rename(staging, root);
      for (const entry of await readdir(dirname(root), { withFileTypes: true })) if (entry.isDirectory() && entry.name !== reference.captureId) await rm(resolve(dirname(root), entry.name), { recursive: true, force: true });
      return { reference: capture.reference, capture, bytes };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    });
  }

  async get(reference) {
    if (!reference) return { status: "unavailable", capture: null, reference: null, reason: "Esta auditoría no contiene una captura de Business Profile." };
    reference = normalizeBusinessProfileReference(reference);
    if (Date.parse(reference.expiresAt) <= Date.parse(this.now())) { await rm(captureRoot(reference), { recursive: true, force: true }).catch(() => {}); return { status: "expired", capture: null, reference, reason: "El contenido temporal de Google ha caducado. Ejecuta de nuevo /seo full para actualizarlo." }; }
    const path = insideCapture(reference, "capture.json");
    const capture = await readJson(path, null).catch(() => null);
    if (!capture || capture.reference?.captureId !== reference.captureId || capture.reference?.profileId !== reference.profileId || capture.reference?.locationName !== reference.locationName) return { status: "unavailable", capture: null, reference, reason: "La captura temporal ya no está disponible." };
    await directorySize(captureRoot(reference));
    return { status: reference.status, capture, reference, reason: null };
  }

  async readAsset(reference, assetId) {
    const result = await this.get(reference);
    if (!result.capture) throw codedError("business-profile-cache-unavailable", result.reason);
    const id = safeId(assetId, "assetId");
    if (!result.capture.media.some((item) => item.assetId === id)) throw new Error("La imagen no pertenece a esta captura.");
    return readFile(insideCapture(result.reference, "assets", `${id}.webp`));
  }
}
