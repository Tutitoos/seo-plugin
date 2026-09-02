import { mkdir, readFile, readdir, writeFile, rename, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensureDataRoot, insideDataRoot, safeId } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";

const STATUSES = new Set(["draft", "completed", "failed"]);

function manifestFrom(input, id, previous = {}) {
  const now = new Date().toISOString();
  const status = input.status || previous.status || "completed";
  if (!STATUSES.has(status)) throw new Error("status debe ser draft, completed o failed.");
  const project = {
    slug: safeId(input.project?.slug || previous.project?.slug, "project.slug"),
    name: String(input.project?.name || previous.project?.name || "").trim(),
  };
  if (!project.name) throw new Error("project.name es obligatorio.");
  const score = input.score ?? previous.score ?? null;
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error("score debe estar entre 0 y 100.");
  return {
    version: 1,
    id,
    title: String(input.title || previous.title || "").trim(),
    project,
    profileId: input.profileId ? safeId(input.profileId, "profileId") : previous.profileId || null,
    auditType: safeId(input.auditType || previous.auditType || "seo-audit", "auditType"),
    status,
    score,
    summary: String(input.summary ?? previous.summary ?? "").trim(),
    skillsUsed: [...new Set(input.skillsUsed || previous.skillsUsed || [])].map((item) => safeId(item, "skill")),
    tags: [...new Set(input.tags || previous.tags || [])].map((item) => String(item).trim()).filter(Boolean),
    artifacts: previous.artifacts || [],
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
}

export class AuditStore {
  async save(input) {
    await ensureDataRoot();
    const id = input.id ? safeId(input.id, "auditId") : `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const folder = insideDataRoot("audits", id);
    const manifestPath = insideDataRoot("audits", id, "manifest.json");
    const reportPath = insideDataRoot("audits", id, "report.md");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const previous = await readJson(manifestPath, {});
    const manifest = manifestFrom(input, id, previous);
    if (!manifest.title) throw new Error("title es obligatorio.");
    await writeJsonAtomic(manifestPath, manifest);
    if (typeof input.reportMarkdown === "string") {
      const temporary = `${reportPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, input.reportMarkdown, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, reportPath);
    }
    return manifest;
  }

  async list(filters = {}) {
    await ensureDataRoot();
    const root = insideDataRoot("audits");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      try { manifests.push(await readJson(insideDataRoot("audits", entry.name, "manifest.json"), null)); } catch {}
    }
    const query = String(filters.query || "").trim().toLowerCase();
    return manifests.filter(Boolean).filter((item) => {
      if (filters.project && item.project?.slug !== filters.project) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (filters.auditType && item.auditType !== filters.auditType) return false;
      if (filters.dateFrom && item.createdAt.slice(0, 10) < filters.dateFrom) return false;
      if (filters.dateTo && item.createdAt.slice(0, 10) > filters.dateTo) return false;
      if (query && !`${item.title} ${item.summary} ${item.project?.name} ${(item.tags || []).join(" ")}`.toLowerCase().includes(query)) return false;
      return true;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id) {
    id = safeId(id, "auditId");
    const manifest = await readJson(insideDataRoot("audits", id, "manifest.json"), null);
    if (!manifest) throw new Error(`No existe la auditoría ${id}.`);
    let reportMarkdown = "";
    try { reportMarkdown = await readFile(insideDataRoot("audits", id, "report.md"), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { manifest, reportMarkdown };
  }
}
