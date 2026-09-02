import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { insideDataRoot, safeId, ensureDataRoot } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";
import { writeAuditFilesAtomic, writeAuditJsonAtomic } from "./audit-storage.mjs";

const SEVERITIES = ["p0", "p1", "p2", "p3", "info"];
const WORKFLOW_STATUSES = ["pending", "in_progress", "resolved", "accepted"];
const HEALTH = ["critical", "issues", "healthy", "unknown"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value, label, max = 500, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`${label} es obligatorio.`);
  if (result.length > max) throw new Error(`${label} supera ${max} caracteres.`);
  return result;
}

function cleanUrl(value, label = "url", required = true) {
  if (!value && !required) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${label} no es una URL válida.`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label} debe ser HTTP(S) y no incluir credenciales.`);
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return url.toString();
}

function boundedArray(value, label, max, mapper = (item) => item) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} debe ser una lista de máximo ${max} elementos.`);
  return value.map(mapper);
}

function finiteOrNull(value, label) {
  if (value == null) return null;
  if (!Number.isFinite(value)) throw new Error(`${label} debe ser un número finito.`);
  return value;
}

function compactObject(value, label, depth = 0) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanText(value, label, 5000);
  if (typeof value === "number") return finiteOrNull(value, label);
  if (depth > 5) throw new Error(`${label} supera la profundidad permitida.`);
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`${label} supera 500 elementos.`);
    return value.map((item, index) => compactObject(item, `${label}[${index}]`, depth + 1));
  }
  if (typeof value !== "object") throw new Error(`${label} contiene un valor no válido.`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error(`${label} supera 100 campos.`);
  return Object.fromEntries(entries.map(([key, item]) => [cleanText(key, `${label}.key`, 80, true), compactObject(item, `${label}.${key}`, depth + 1)]));
}

export function normalizePageUrl(value) {
  const url = new URL(cleanUrl(value));
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  url.searchParams.sort();
  return url.toString();
}

export function pageIdForUrl(value) {
  return `page-${createHash("sha256").update(normalizePageUrl(value)).digest("hex").slice(0, 20)}`;
}

function fingerprintForFinding(item) {
  const scope = item.scope || "global";
  const targets = boundedArray(item.affectedUrls || item.resources, "finding.targets", 500, (url) => scope === "page" ? normalizePageUrl(url) : cleanText(url, "finding.resource", 240, true)).sort();
  return createHash("sha256").update(JSON.stringify([safeId(item.ruleId, "finding.ruleId"), scope, targets])).digest("hex").slice(0, 24);
}

function normalizeAction(action, index) {
  return {
    title: cleanText(action.title, `actions[${index}].title`, 140, true),
    why: cleanText(action.why, `actions[${index}].why`, 500, true),
    steps: boundedArray(action.steps, `actions[${index}].steps`, 12, (step) => cleanText(step, "action.step", 400, true)),
    validation: cleanText(action.validation, `actions[${index}].validation`, 500, true),
    ownerRole: cleanText(action.ownerRole, `actions[${index}].ownerRole`, 100),
    effort: ["xs", "s", "m", "l", "xl"].includes(action.effort) ? action.effort : "m",
  };
}

function normalizeFinding(item, index) {
  const severity = String(item.severity || "p2").toLowerCase();
  if (!SEVERITIES.includes(severity)) throw new Error(`findings[${index}].severity no es válida.`);
  const scope = ["global", "page", "resource"].includes(item.scope) ? item.scope : "global";
  const normalized = {
    id: item.id ? safeId(item.id, `findings[${index}].id`) : `finding-${randomUUID().slice(0, 8)}`,
    ruleId: safeId(item.ruleId, `findings[${index}].ruleId`), scope, severity,
    category: safeId(item.category || "technical", `findings[${index}].category`),
    title: cleanText(item.title, `findings[${index}].title`, 180, true),
    explanation: cleanText(item.explanation, `findings[${index}].explanation`, 1200, true),
    evidence: cleanText(item.evidence, `findings[${index}].evidence`, 2000, true),
    impact: cleanText(item.impact, `findings[${index}].impact`, 1200, true),
    affectedUrls: boundedArray(item.affectedUrls, `findings[${index}].affectedUrls`, 500, (url) => normalizePageUrl(url)),
    resources: boundedArray(item.resources, `findings[${index}].resources`, 100, (resource) => cleanText(resource, "finding.resource", 240, true)),
    source: cleanText(item.source, `findings[${index}].source`, 120, true),
    confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "high",
    actions: boundedArray(item.actions, `findings[${index}].actions`, 8, normalizeAction),
    observedAt: item.observedAt ? new Date(item.observedAt).toISOString() : new Date().toISOString(),
  };
  if (severity !== "info" && normalized.actions.length === 0) throw new Error(`findings[${index}].actions requiere al menos una acción para incidencias ${severity}.`);
  normalized.fingerprint = fingerprintForFinding(normalized);
  return normalized;
}

function issueCounts(findings) {
  return Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
}

function healthFromCounts(counts, coverage) {
  if ((counts?.p0 || 0) > 0) return "critical";
  if ((counts?.p1 || 0) > 0 || (counts?.p2 || 0) > 0 || (counts?.p3 || 0) > 0) return "issues";
  return coverage === "complete" ? "healthy" : "unknown";
}

function normalizePage(input, index) {
  const url = normalizePageUrl(input.url);
  const canonicalUrl = input.canonicalUrl ? normalizePageUrl(input.canonicalUrl) : null;
  const auditLevel = input.auditLevel === "deep" ? "deep" : "light";
  const coverage = ["complete", "partial", "none"].includes(input.coverage) ? input.coverage : "partial";
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, Math.max(0, Number(input.issueCounts?.[severity]) || 0)]));
  return {
    id: pageIdForUrl(url), url, canonicalUrl,
    discoverySources: boundedArray(input.discoverySources, `pages[${index}].discoverySources`, 8, (item) => safeId(item, "discoverySource")),
    sitemapUrls: boundedArray(input.sitemapUrls, `pages[${index}].sitemapUrls`, 20, (item) => cleanUrl(item)),
    template: cleanText(input.template, `pages[${index}].template`, 80), locale: cleanText(input.locale, `pages[${index}].locale`, 24),
    expectedLocale: cleanText(input.expectedLocale, `pages[${index}].expectedLocale`, 24),
    declaredLocale: cleanText(input.declaredLocale || input.locale, `pages[${index}].declaredLocale`, 24),
    aliases: boundedArray(input.aliases, `pages[${index}].aliases`, 20, (item) => cleanUrl(item)),
    healthReason: cleanText(input.healthReason, `pages[${index}].healthReason`, 240),
    evidence: compactObject(input.evidence || {}, `pages[${index}].evidence`),
    depth: Math.max(0, Math.min(50, Number(input.depth) || 0)), auditLevel, coverage,
    health: healthFromCounts(counts, coverage), issueCounts: counts,
    findingIds: boundedArray(input.findingIds, `pages[${index}].findingIds`, 100, (item) => safeId(item, "findingId")),
    fetchedAt: input.fetchedAt ? new Date(input.fetchedAt).toISOString() : new Date().toISOString(),
    response: compactObject(input.response || {}, `pages[${index}].response`),
    indexability: compactObject(input.indexability || {}, `pages[${index}].indexability`),
    metadata: compactObject(input.metadata || {}, `pages[${index}].metadata`),
    links: compactObject(input.links || {}, `pages[${index}].links`),
    images: compactObject(input.images || {}, `pages[${index}].images`),
    schemas: compactObject(input.schemas || {}, `pages[${index}].schemas`),
    performance: compactObject(input.performance || {}, `pages[${index}].performance`),
    searchConsole: compactObject(input.searchConsole || {}, `pages[${index}].searchConsole`),
    analytics: compactObject(input.analytics || {}, `pages[${index}].analytics`),
    screenshots: boundedArray(input.screenshots, `pages[${index}].screenshots`, 4, (item) => ({ label: cleanText(item.label, "screenshot.label", 80, true), path: cleanText(item.path, "screenshot.path", 180, true) })),
    diagnostics: boundedArray(input.diagnostics, `pages[${index}].diagnostics`, 30, (item) => compactObject(item, "page.diagnostic")),
    metrics: input.metrics ? compactObject(input.metrics, `pages[${index}].metrics`) : { version: 4, kpis: [], datasets: [], charts: [] },
  };
}

function pageSummary(page) {
  const { metrics, response, indexability, metadata, links, images, schemas, performance, searchConsole, analytics, screenshots, diagnostics, ...summary } = page;
  return { ...summary, status: response?.status ?? null, indexable: indexability?.indexable ?? null, title: metadata?.title ?? "", clicks: searchConsole?.clicks ?? null, impressions: searchConsole?.impressions ?? null, ctr: searchConsole?.ctr ?? null, position: searchConsole?.position ?? null, sessions: analytics?.sessions ?? null };
}

function normalizeDiagnostic(item, index) {
  return {
    code: safeId(item.code, `diagnostics[${index}].code`),
    stage: safeId(item.stage || "collection", `diagnostics[${index}].stage`),
    source: cleanText(item.source, `diagnostics[${index}].source`, 120, true),
    scope: cleanText(item.scope, `diagnostics[${index}].scope`, 240),
    message: cleanText(item.message, `diagnostics[${index}].message`, 800, true),
    retryable: Boolean(item.retryable),
    completenessImpact: cleanText(item.completenessImpact, `diagnostics[${index}].completenessImpact`, 500, true),
    nextAction: cleanText(item.nextAction, `diagnostics[${index}].nextAction`, 800, true),
    attemptedAt: item.attemptedAt ? new Date(item.attemptedAt).toISOString() : new Date().toISOString(),
  };
}

export class AuditDetailStore {
  constructor({ now = () => new Date().toISOString() } = {}) { this.now = now; }

  async manifest(auditId) {
    const id = safeId(auditId, "auditId");
    const manifest = await readJson(insideDataRoot("audits", id, "manifest.json"), null);
    if (!manifest) throw new Error(`No existe la auditoría ${id}.`);
    return manifest;
  }

  async writable(auditId) {
    const manifest = await this.manifest(auditId);
    if (manifest.status === "completed") throw new Error(`La auditoría ${manifest.id} está completada y es inmutable.`);
    return manifest;
  }

  async updateContent(auditId, partial) {
    const manifest = await this.manifest(auditId);
    const content = { ...(manifest.content || {}), ...partial };
    await writeAuditJsonAtomic(manifest.id, "manifest.json", { ...manifest, version: Math.max(manifest.version || 1, 4), content, updatedAt: this.now() });
  }

  async saveFindings(auditId, input) {
    const manifest = await this.writable(auditId);
    if (!Array.isArray(input) || input.length > 1000) throw new Error("findings debe contener como máximo 1000 elementos.");
    const findings = input.map(normalizeFinding);
    if (new Set(findings.map((item) => item.fingerprint)).size !== findings.length) throw new Error("findings contiene incidencias duplicadas.");
    const payload = { version: 4, updatedAt: this.now(), counts: issueCounts(findings), findings };
    const nextManifest = { ...manifest, version: Math.max(manifest.version || 1, 4), content: { ...(manifest.content || {}), findings: { path: "findings.json", count: findings.length, counts: payload.counts } }, updatedAt: this.now() };
    await writeAuditFilesAtomic(manifest.id, [{ relativePath: "findings.json", value: payload }, { relativePath: "manifest.json", value: nextManifest }]);
    await this.reconcileIssues(manifest, findings);
    return payload;
  }

  async saveInventory(auditId, inventory, diagnostics = undefined) {
    const manifest = await this.writable(auditId);
    const payload = { version: 4, updatedAt: this.now(), ...compactObject(inventory || {}, "inventory") };
    const diagnosticList = diagnostics === undefined ? await readJson(insideDataRoot("audits", manifest.id, "diagnostics.json"), { version: 4, diagnostics: [] }) : { version: 4, updatedAt: this.now(), diagnostics: boundedArray(diagnostics, "diagnostics", 500, normalizeDiagnostic) };
    const nextManifest = { ...manifest, version: Math.max(manifest.version || 1, 4), content: { ...(manifest.content || {}), inventory: { path: "inventory.json" }, diagnostics: { path: "diagnostics.json", count: diagnosticList.diagnostics?.length || 0 } }, updatedAt: this.now() };
    const files = [{ relativePath: "inventory.json", value: payload }, { relativePath: "manifest.json", value: nextManifest }];
    if (diagnostics !== undefined) files.splice(1, 0, { relativePath: "diagnostics.json", value: diagnosticList });
    await writeAuditFilesAtomic(manifest.id, files);
    return { inventory: payload, diagnostics: diagnosticList };
  }

  async savePageBatch(auditId, input) {
    const manifest = await this.writable(auditId);
    if (!Array.isArray(input) || input.length < 1 || input.length > 25) throw new Error("pages debe contener entre 1 y 25 páginas por lote.");
    const pages = input.map(normalizePage);
    if (new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error("pages contiene URLs canónicas duplicadas.");
    const indexPath = insideDataRoot("audits", manifest.id, "pages", "index.json");
    const current = await readJson(indexPath, { version: 4, pages: [] });
    const byId = new Map((current.pages || []).map((page) => [page.id, page]));
    for (const page of pages) byId.set(page.id, pageSummary(page));
    const all = [...byId.values()].sort((a, b) => a.url.localeCompare(b.url));
    if (all.length > 500) throw new Error("La auditoría supera el límite de 500 páginas.");
    if (all.filter((page) => page.auditLevel === "deep").length > 50) throw new Error("La auditoría supera el límite de 50 páginas profundas.");
    const payload = { version: 4, updatedAt: this.now(), pages: all };
    const nextManifest = { ...manifest, version: Math.max(manifest.version || 1, 4), content: { ...(manifest.content || {}), pages: { path: "pages/index.json", count: all.length, deepCount: all.filter((page) => page.auditLevel === "deep").length } }, updatedAt: this.now() };
    const files = [];
    for (const page of pages) {
      const { metrics, ...pagePayload } = page;
      files.push({ relativePath: `pages/${page.id}/page.json`, value: pagePayload }, { relativePath: `pages/${page.id}/metrics.json`, value: metrics });
    }
    files.push({ relativePath: "pages/index.json", value: payload }, { relativePath: "manifest.json", value: nextManifest });
    await writeAuditFilesAtomic(manifest.id, files);
    return { saved: pages.length, total: all.length, deepCount: all.filter((page) => page.auditLevel === "deep").length };
  }

  async listPages(auditId, filters = {}) {
    const manifest = await this.manifest(auditId);
    const index = await readJson(insideDataRoot("audits", manifest.id, "pages", "index.json"), { version: 4, pages: [] });
    const query = cleanText(filters.query, "query", 240).toLowerCase();
    let pages = index.pages.filter((page) => {
      if (query && !`${page.url} ${page.title} ${page.template}`.toLowerCase().includes(query)) return false;
      if (filters.sitemap && !page.sitemapUrls.includes(filters.sitemap)) return false;
      if (filters.template && page.template !== filters.template) return false;
      if (filters.locale && page.locale !== filters.locale) return false;
      if (filters.health && page.health !== filters.health) return false;
      if (filters.coverage && page.coverage !== filters.coverage) return false;
      if (filters.indexability === "indexable" && page.indexable !== true) return false;
      if (filters.indexability === "blocked" && page.indexable !== false) return false;
      return true;
    });
    const sort = ["url", "status", "health", "clicks", "sessions"].includes(filters.sort) ? filters.sort : "url";
    const direction = filters.order === "desc" ? -1 : 1;
    pages.sort((a, b) => direction * String(a[sort] ?? "").localeCompare(String(b[sort] ?? ""), "es", { numeric: true }));
    const offset = Math.max(0, Number(filters.offset) || 0), limit = Math.max(1, Math.min(100, Number(filters.limit) || 50));
    return { auditId: manifest.id, total: pages.length, offset, limit, pages: pages.slice(offset, offset + limit), facets: { templates: [...new Set(index.pages.map((page) => page.template).filter(Boolean))], locales: [...new Set(index.pages.map((page) => page.locale).filter(Boolean))], sitemaps: [...new Set(index.pages.flatMap((page) => page.sitemapUrls))] } };
  }

  async getPage(auditId, pageId) {
    const manifest = await this.manifest(auditId);
    const id = safeId(pageId, "pageId");
    const page = await readJson(insideDataRoot("audits", manifest.id, "pages", id, "page.json"), null);
    if (!page) throw new Error(`No existe la página ${id} en la auditoría ${manifest.id}.`);
    const metrics = await readJson(insideDataRoot("audits", manifest.id, "pages", id, "metrics.json"), { version: 4, kpis: [], datasets: [], charts: [] });
    const findings = await this.getFindings(manifest.id);
    const tracker = await this.listIssues(manifest.project.slug);
    const related = findings.findings.filter((finding) => page.findingIds?.includes(finding.id) || finding.affectedUrls?.includes(page.url) || finding.affectedUrls?.includes(page.canonicalUrl));
    return { manifest, page, metrics, findings: related.map((finding) => ({ ...finding, workflow: tracker.issues.find((issue) => issue.fingerprint === finding.fingerprint) || null })) };
  }

  async getFindings(auditId) {
    const manifest = await this.manifest(auditId);
    return readJson(insideDataRoot("audits", manifest.id, "findings.json"), { version: 4, counts: issueCounts([]), findings: [] });
  }

  async getInventory(auditId) {
    const manifest = await this.manifest(auditId);
    const inventory = await readJson(insideDataRoot("audits", manifest.id, "inventory.json"), { version: 4 });
    const diagnostics = await readJson(insideDataRoot("audits", manifest.id, "diagnostics.json"), { version: 4, diagnostics: [] });
    return { inventory, diagnostics };
  }

  async listIssues(projectId) {
    const id = safeId(projectId, "projectId");
    return readJson(insideDataRoot("projects", id, "issues.json"), { version: 3, projectId: id, updatedAt: null, issues: [] });
  }

  async reconcileIssues(manifest, findings) {
    await ensureDataRoot();
    const projectId = safeId(manifest.project.slug, "projectId");
    const folder = insideDataRoot("projects", projectId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const tracker = await this.listIssues(projectId);
    const now = this.now(), seen = new Set(findings.map((item) => item.fingerprint));
    const byFingerprint = new Map(tracker.issues.map((issue) => [issue.fingerprint, issue]));
    for (const finding of findings) {
      const previous = byFingerprint.get(finding.fingerprint);
      const reopened = previous?.status === "resolved" && previous?.lastAuditId !== manifest.id;
      byFingerprint.set(finding.fingerprint, {
        fingerprint: finding.fingerprint, ruleId: finding.ruleId, title: finding.title, severity: finding.severity,
        status: reopened ? "pending" : previous?.status || "pending", owner: previous?.owner || "", dueDate: previous?.dueDate || null,
        notes: previous?.notes || [], acceptanceReason: previous?.acceptanceReason || "", firstSeenAt: previous?.firstSeenAt || now,
        lastSeenAt: now, lastAuditId: manifest.id, auditIds: [...new Set([...(previous?.auditIds || []), manifest.id])].slice(-50),
        detected: true, verification: reopened ? "reopened" : previous?.verification || "unverified", verifiedAt: null,
      });
    }
    for (const [fingerprint, issue] of byFingerprint) {
      if (seen.has(fingerprint)) continue;
      if (issue.status === "accepted") {
        byFingerprint.set(fingerprint, { ...issue, detected: false, verifiedAt: now });
        continue;
      }
      if (["pending", "in_progress", "resolved"].includes(issue.status)) {
        const verified = issue.lastAuditId !== manifest.id;
        byFingerprint.set(fingerprint, { ...issue, status: "resolved", detected: false, verification: verified ? "verified" : "awaiting_verification", verifiedAt: verified ? now : null });
      }
    }
    const payload = { version: 3, projectId, updatedAt: now, issues: [...byFingerprint.values()].sort((a, b) => a.severity.localeCompare(b.severity) || b.lastSeenAt.localeCompare(a.lastSeenAt)) };
    await writeJsonAtomic(insideDataRoot("projects", projectId, "issues.json"), payload);
    return payload;
  }

  async manageWorkflow(input) {
    const projectId = safeId(input.projectId, "projectId");
    const tracker = await this.listIssues(projectId);
    if (input.action === "list") return tracker;
    const fingerprint = cleanText(input.fingerprint, "fingerprint", 64, true);
    const issue = tracker.issues.find((item) => item.fingerprint === fingerprint);
    if (!issue) throw new Error(`No existe la incidencia ${fingerprint}.`);
    if (input.action === "get") return issue;
    const status = input.status || issue.status;
    if (!WORKFLOW_STATUSES.includes(status)) throw new Error("status de incidencia no es válido.");
    const acceptanceReason = input.acceptanceReason === undefined ? issue.acceptanceReason : cleanText(input.acceptanceReason, "acceptanceReason", 1000);
    if (status === "accepted" && !acceptanceReason) throw new Error("Aceptar un riesgo requiere un motivo.");
    const dueDate = input.dueDate === undefined ? issue.dueDate : input.dueDate || null;
    if (dueDate && !DATE.test(dueDate)) throw new Error("dueDate debe usar formato YYYY-MM-DD.");
    const next = { ...issue, status, owner: input.owner === undefined ? issue.owner : cleanText(input.owner, "owner", 120), dueDate, acceptanceReason, verification: status === "resolved" ? "awaiting_verification" : issue.verification, updatedAt: this.now() };
    if (input.note) next.notes = [...issue.notes, { id: randomUUID(), text: cleanText(input.note, "note", 1200, true), createdAt: this.now() }].slice(-100);
    const payload = { ...tracker, updatedAt: this.now(), issues: tracker.issues.map((item) => item.fingerprint === fingerprint ? next : item) };
    await mkdir(insideDataRoot("projects", projectId), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(insideDataRoot("projects", projectId, "issues.json"), payload);
    return next;
  }
}
