import { mkdir, readdir, lstat, open, rename, writeFile, chmod, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { insideDataRoot, safeId } from "./data-root.mjs";

// The quota is deliberately fixed: audit snapshots are portable and predictable.
// Keep the quota in decimal bytes to match the dashboard's macOS-style units:
// 512 MB is exactly 512,000,000 bytes.
export const AUDIT_STORAGE_LIMIT_BYTES = 512_000_000;
export const AUDIT_STORAGE_LIMIT_LABEL = "512 MB";
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 120_000;

function quotaError(message, details = {}) {
  const error = new Error(message);
  error.code = "audit-storage-limit-exceeded";
  Object.assign(error, details);
  return error;
}

function symlinkError(path) {
  const error = new Error(`No se permiten enlaces simbólicos dentro de una auditoría: ${path}`);
  error.code = "audit-storage-symlink";
  error.path = path;
  return error;
}

async function recordQuotaFailure(auditId, error) {
  // Run state is deliberately outside the snapshot quota so a rejected write
  // can still explain itself and be resumed by the orchestrator.
  try {
    const { AuditRunStore } = await import("./run-status.mjs");
    const runs = new AuditRunStore();
    const current = await runs.get(auditId);
    const diagnostic = {
      code: error.code,
      stage: current.stage || "queued",
      source: "audit-storage",
      scope: auditId,
      message: error.message,
      retryable: false,
      completenessImpact: "La escritura se rechazó antes de modificar el snapshot.",
      nextAction: "Libera espacio fuera de esta auditoría o crea un nuevo snapshot y reanuda las fases pendientes.",
      attemptedAt: new Date().toISOString(),
      usedBytes: error.usedBytes,
      requestedBytes: error.requestedBytes,
      availableBytes: error.availableBytes,
    };
    await runs.update(auditId, { status: "failed", lastError: diagnostic, diagnostics: [...(current.diagnostics || []).filter((item) => item.code !== error.code), diagnostic] });
  } catch {
    // Reporting must never turn a safe rejection into a partial write.
  }
}

function auditRoot(auditId) {
  return insideDataRoot("audits", safeId(auditId, "auditId"));
}

function auditPath(auditId, relativePath) {
  const root = auditRoot(auditId);
  const clean = String(relativePath || "").replaceAll("\\", "/");
  if (!clean || clean.startsWith("/") || clean.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("La ruta del archivo de auditoría no es válida.");
  }
  const target = resolve(root, clean);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("La ruta solicitada está fuera de la auditoría.");
  return target;
}

function bucket(relativePath) {
  if (relativePath === "report.md") return "report";
  if (relativePath.startsWith("pages/") && relativePath.includes("/assets/")) return "assets";
  if (relativePath.startsWith("pages/")) return "pages";
  return "structured";
}

async function walk(root, current = root, result = { bytes: 0, files: 0, symlinks: [], breakdown: { structured: 0, report: 0, pages: 0, assets: 0 } }) {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return result; throw error; }
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isSymbolicLink()) { result.symlinks.push(relativePath); continue; }
    if (info.isDirectory()) { await walk(root, path, result); continue; }
    if (!info.isFile()) continue;
    result.files += 1;
    result.bytes += info.size;
    result.breakdown[bucket(relativePath)] += info.size;
  }
  return result;
}

export async function measureAuditStorage(auditId) {
  const root = auditRoot(auditId);
  const result = await walk(root);
  if (result.symlinks.length) throw symlinkError(result.symlinks[0]);
  const availableBytes = Math.max(0, AUDIT_STORAGE_LIMIT_BYTES - result.bytes);
  return {
    auditId: safeId(auditId, "auditId"),
    usedBytes: result.bytes,
    limitBytes: AUDIT_STORAGE_LIMIT_BYTES,
    limitLabel: AUDIT_STORAGE_LIMIT_LABEL,
    availableBytes,
    percent: Number((result.bytes / AUDIT_STORAGE_LIMIT_BYTES * 100).toFixed(3)),
    files: result.files,
    breakdown: result.breakdown,
    status: result.bytes >= AUDIT_STORAGE_LIMIT_BYTES ? "limit" : result.bytes >= AUDIT_STORAGE_LIMIT_BYTES * .9 ? "critical" : result.bytes >= AUDIT_STORAGE_LIMIT_BYTES * .8 ? "warning" : "normal",
  };
}

async function lockPath(auditId) {
  return insideDataRoot(".locks", `${safeId(auditId, "auditId")}.storage.lock`);
}

async function acquireLock(auditId) {
  const path = await lockPath(auditId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return path;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await lstat(path);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(path, { force: true });
      } catch (readError) { if (readError?.code !== "ENOENT") throw readError; }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`No se pudo bloquear la auditoría ${auditId} para escribir.`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_WAIT_MS));
    }
  }
}

async function withLock(auditId, callback) {
  const lock = await acquireLock(auditId);
  try { return await callback(); }
  finally { await rm(lock, { force: true }).catch(() => {}); }
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

async function validateTargetParents(root, target) {
  let current = dirname(target);
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw symlinkError(relative(root, current).split(sep).join("/"));
      if (!info.isDirectory()) throw new Error(`La carpeta de destino no es un directorio: ${relative(root, current)}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

/**
 * Writes all files as one quota-checked batch. Temporary files live outside the
 * audit so the quota measures the committed snapshot, never staging bytes.
 */
export async function writeAuditFilesAtomic(auditId, entries) {
  const id = safeId(auditId, "auditId");
  if (!Array.isArray(entries) || entries.length < 1) throw new Error("Se requiere al menos un archivo de auditoría.");
  const normalized = entries.map((entry) => ({ relativePath: String(entry.relativePath), bytes: entry.bytes !== undefined ? asBuffer(entry.bytes) : asBuffer(`${JSON.stringify(entry.value)}\n`) }));
  if (new Set(normalized.map((entry) => entry.relativePath)).size !== normalized.length) throw new Error("No se puede escribir dos veces el mismo archivo en un lote.");
  return withLock(id, async () => {
    const root = auditRoot(id);
    const before = await measureAuditStorage(id);
    let projected = before.usedBytes;
    const targets = [];
    for (const entry of normalized) {
      const target = auditPath(id, entry.relativePath);
      await validateTargetParents(root, target);
      let previousSize = 0;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw symlinkError(entry.relativePath);
        if (info.isFile()) previousSize = info.size;
        else if (info.isDirectory()) throw new Error(`El destino no es un archivo: ${entry.relativePath}`);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      projected += entry.bytes.length - previousSize;
      targets.push({ ...entry, target });
    }
    if (projected > AUDIT_STORAGE_LIMIT_BYTES) {
      const error = quotaError(`La auditoría ${id} superaría el límite de ${AUDIT_STORAGE_LIMIT_LABEL}.`, { auditId: id, usedBytes: before.usedBytes, requestedBytes: projected - before.usedBytes, availableBytes: before.availableBytes, limitBytes: AUDIT_STORAGE_LIMIT_BYTES, projectedBytes: projected });
      await recordQuotaFailure(id, error);
      throw error;
    }
    const tempRoot = insideDataRoot(".tmp", `audit-${id}-${randomUUID()}`);
    const staged = [];
    try {
      for (const item of targets) {
        const temporary = resolve(tempRoot, item.relativePath);
        await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
        await writeFile(temporary, item.bytes, { mode: 0o600 });
        await chmod(temporary, 0o600).catch(() => {});
        staged.push({ temporary, target: item.target });
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700).catch(() => {});
      for (const item of staged) {
        await mkdir(dirname(item.target), { recursive: true, mode: 0o700 });
        await chmod(dirname(item.target), 0o700).catch(() => {});
        await rename(item.temporary, item.target);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
    return measureAuditStorage(id);
  });
}

export async function writeAuditJsonAtomic(auditId, relativePath, value) {
  return writeAuditFilesAtomic(auditId, [{ relativePath, bytes: `${JSON.stringify(value, null, 2)}\n` }]);
}

export function auditStorageError(error) {
  return error?.code === "audit-storage-limit-exceeded" || error?.code === "audit-storage-symlink";
}
