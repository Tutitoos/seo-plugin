import { ensureDataRoot, insideDataRoot, safeId } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";

const STAGES = ["queued", "crawl", "render", "lighthouse", "google", "reconcile", "complete", "failed"];

export class AuditRunStore {
  constructor({ now = () => new Date().toISOString() } = {}) { this.now = now; }

  path(auditId) { return insideDataRoot("runs", `${safeId(auditId, "auditId")}.json`); }

  async get(auditId) {
    const id = safeId(auditId, "auditId");
    return readJson(this.path(id), { version: 1, auditId: id, stage: "queued", status: "idle", completedStages: [], diagnostics: [], updatedAt: null });
  }

  async update(auditId, patch = {}) {
    await ensureDataRoot();
    const current = await this.get(auditId);
    const stage = patch.stage || current.stage;
    if (!STAGES.includes(stage)) throw new Error(`stage no válido: ${stage}`);
    const next = { ...current, ...patch, version: 1, auditId: current.auditId, stage, updatedAt: this.now() };
    await writeJsonAtomic(this.path(current.auditId), next);
    return next;
  }
}

export { STAGES };
