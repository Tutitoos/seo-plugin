import { insideDataRoot, safeId, ensureDataRoot } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";

const DEFAULT_TARGETS = {
  "critical-findings": { operator: "lte", value: 0 },
  "broken-links": { operator: "lte", value: 0 },
  "server-errors": { operator: "lte", value: 0 },
  "sitemap-conflicts": { operator: "lte", value: 0 },
  "mobile-lcp": { operator: "lte", value: 2.5, warningValue: 4 },
  inp: { operator: "lte", value: 200, warningValue: 500 },
  cls: { operator: "lte", value: 0.1, warningValue: 0.25 },
};
const OPERATORS = new Set(["lte", "gte", "eq", "between"]);
const EMPTY = { version: 1, projects: [] };

function cleanTarget(target, id) {
  if (!target || !OPERATORS.has(target.operator)) throw new Error(`Objetivo inválido para ${id}.`);
  if (!Number.isFinite(target.value)) throw new Error(`El objetivo ${id} requiere un valor finito.`);
  const result = { operator: target.operator, value: target.value };
  if (target.warningValue != null) {
    if (!Number.isFinite(target.warningValue)) throw new Error(`warningValue inválido para ${id}.`);
    result.warningValue = target.warningValue;
  }
  if (target.maxValue != null) {
    if (!Number.isFinite(target.maxValue)) throw new Error(`maxValue inválido para ${id}.`);
    result.maxValue = target.maxValue;
  }
  return result;
}

function validateRegistry(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.projects)) throw new Error("projects.json no usa el esquema compatible version=1.");
  const ids = new Set();
  for (const project of registry.projects) {
    safeId(project.id, "project.id");
    if (ids.has(project.id)) throw new Error(`Proyecto duplicado: ${project.id}.`);
    ids.add(project.id);
    if (typeof project.timezone !== "string" || !project.timezone.trim()) throw new Error(`El proyecto ${project.id} no tiene timezone.`);
    try { new Intl.DateTimeFormat("es", { timeZone: project.timezone }); } catch { throw new Error(`Timezone inválida para ${project.id}.`); }
    if (!/^[A-Z]{3}$/.test(project.currency)) throw new Error(`Currency inválida para ${project.id}.`);
    for (const [id, target] of Object.entries(project.targets || {})) cleanTarget(target, id);
  }
  return registry;
}

export class ProjectSettingsStore {
  constructor({ path = insideDataRoot("config", "projects.json"), now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
  }

  async load() { await ensureDataRoot(); return validateRegistry(await readJson(this.path, EMPTY)); }
  async list() { return this.load(); }

  async get(projectId) {
    const id = safeId(projectId, "projectId");
    const registry = await this.load();
    const saved = registry.projects.find((project) => project.id === id);
    return saved || { id, timezone: "Europe/Madrid", currency: "EUR", targets: {}, createdAt: null, updatedAt: null };
  }

  async resolved(projectId) {
    const project = await this.get(projectId);
    return { ...project, targets: { ...DEFAULT_TARGETS, ...(project.targets || {}) } };
  }

  async upsert({ id, timezone, currency, targets }) {
    id = safeId(id, "projectId");
    const registry = await this.load();
    const existing = registry.projects.find((project) => project.id === id);
    const nextTargets = { ...(existing?.targets || {}) };
    for (const [targetId, target] of Object.entries(targets || {})) {
      const cleanId = safeId(targetId, "targetId");
      if (target === null) delete nextTargets[cleanId];
      else nextTargets[cleanId] = cleanTarget(target, cleanId);
    }
    const now = this.now();
    const project = {
      id,
      timezone: String(timezone || existing?.timezone || "Europe/Madrid"),
      currency: String(currency || existing?.currency || "EUR").toUpperCase(),
      targets: nextTargets,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    registry.projects = registry.projects.filter((item) => item.id !== id).concat(project);
    validateRegistry(registry);
    await writeJsonAtomic(this.path, registry);
    return this.resolved(id);
  }
}

export { DEFAULT_TARGETS };
