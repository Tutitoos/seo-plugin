import { AuditStore } from "./audit-store.mjs";
import { AuditDetailStore, normalizePageUrl } from "./audit-detail-store.mjs";
import { safeId } from "./data-root.mjs";

const TRACKED_FIELDS = [
  ["HTTP", (page) => page.response?.status ?? null],
  ["Indexabilidad", (page) => page.indexability?.indexable ?? null],
  ["Canonical", (page) => page.canonicalUrl ?? null],
  ["Título", (page) => page.metadata?.title ?? null],
  ["Descripción", (page) => page.metadata?.description ?? null],
  ["H1", (page) => page.metadata?.h1Count ?? null],
  ["Enlaces internos", (page) => page.links?.internalCount ?? null],
  ["Imágenes sin alt", (page) => page.images?.missingAlt ?? null],
  ["Schema", (page) => (page.schemas?.types || []).slice().sort().join(",")],
  ["LCP móvil", (page) => page.performance?.lab?.mobile?.median?.lcpMs ?? null],
  ["LCP escritorio", (page) => page.performance?.lab?.desktop?.median?.lcpMs ?? null],
  ["CLS móvil", (page) => page.performance?.lab?.mobile?.median?.cls ?? null],
  ["Clics GSC", (page) => page.searchConsole?.clicks ?? null],
  ["Impresiones GSC", (page) => page.searchConsole?.impressions ?? null],
  ["CTR GSC", (page) => page.searchConsole?.ctr ?? null],
  ["Posición GSC", (page) => page.searchConsole?.position ?? null],
  ["Sesiones GA4", (page) => page.analytics?.sessions ?? null],
  ["Usuarios GA4", (page) => page.analytics?.users ?? null],
  ["Conversiones GA4", (page) => page.analytics?.conversions ?? null],
];

const valueEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const healthRank = { critical: 0, issues: 1, unknown: 2, healthy: 3 };

async function allPages(details, auditId) {
  const pages = [];
  for (let offset = 0; ; offset += 100) {
    const result = await details.listPages(auditId, { offset, limit: 100 });
    pages.push(...result.pages);
    if (pages.length >= result.total || result.pages.length === 0) return { ...result, pages, total: result.total };
  }
}

function pageStatus(current, previous, fields) {
  const currentRank = healthRank[current.health] ?? 2, previousRank = healthRank[previous.health] ?? 2;
  if (currentRank > previousRank) return "mejorado";
  if (currentRank < previousRank) return "regresión";
  const http = fields.find((field) => field.field === "HTTP");
  if (http && Number(http.previous) >= 400 && Number(http.current) < 400) return "mejorado";
  if (http && Number(http.previous) < 400 && Number(http.current) >= 400) return "regresión";
  const indexability = fields.find((field) => field.field === "Indexabilidad");
  if (indexability && indexability.previous === false && indexability.current === true) return "mejorado";
  if (indexability && indexability.previous === true && indexability.current === false) return "regresión";
  return "sin cambios";
}

function metricChanges(current, previous) {
  const before = new Map((previous?.kpis || []).map((item) => [item.id, item]));
  return (current?.kpis || []).map((item) => {
    const old = before.get(item.id);
    if (!old) return { id: item.id, label: item.label, status: "nuevo", current: item.value, previous: null };
    return { id: item.id, label: item.label, status: valueEqual(item.value, old.value) ? "sin cambios" : "actualizado", current: item.value, previous: old.value, delta: item.delta };
  }).concat([...before.values()].filter((item) => !(current?.kpis || []).some((next) => next.id === item.id)).map((item) => ({ id: item.id, label: item.label, status: "resuelto", current: null, previous: item.value })));
}

export async function getAuditChanges(auditId) {
  const id = safeId(auditId, "auditId"), audits = new AuditStore(), details = new AuditDetailStore();
  const current = await audits.get(id);
  const snapshots = await audits.list({ project: current.manifest.project.slug, order: "asc" });
  const index = snapshots.findIndex((item) => item.id === id), previousSummary = index > 0 ? snapshots[index - 1] : null;
  if (!previousSummary) return { auditId: id, previousAuditId: null, comparable: false, pageChanges: [], metricChanges: [], findingChanges: { new: [], persistent: [], resolved: [], reopened: [] }, counts: { pages: 0, changedPages: 0, findings: 0 } };
  const [currentPages, previousPages, currentFindings, previousFindings, currentMetrics, previousMetrics] = await Promise.all([
    allPages(details, id), allPages(details, previousSummary.id), details.getFindings(id), details.getFindings(previousSummary.id), audits.get(id).then((result) => result.metrics), audits.get(previousSummary.id).then((result) => result.metrics),
  ]);
  const currentByUrl = new Map(currentPages.pages.map((page) => [normalizePageUrl(page.url), page]));
  const previousByUrl = new Map(previousPages.pages.map((page) => [normalizePageUrl(page.url), page]));
  const pageChanges = [];
  for (const [url, page] of currentByUrl) {
    const previousPage = previousByUrl.get(url);
    if (!previousPage) { pageChanges.push({ pageId: page.id, url, status: "nuevo", fields: [], currentHealth: page.health, previousHealth: null }); continue; }
    const fields = [];
    for (const [label, read] of TRACKED_FIELDS) {
      const currentValue = read(page), previousValue = read(previousPage);
      if (!valueEqual(currentValue, previousValue)) fields.push({ field: label, current: currentValue, previous: previousValue });
    }
    if (page.health !== previousPage.health) fields.push({ field: "Salud", current: page.health, previous: previousPage.health });
    pageChanges.push({ pageId: page.id, url, status: pageStatus(page, previousPage, fields), fields, currentHealth: page.health, previousHealth: previousPage.health });
  }
  for (const [url, page] of previousByUrl) if (!currentByUrl.has(url)) pageChanges.push({ pageId: page.id, url, status: "resuelto", fields: [], currentHealth: null, previousHealth: page.health });
  const currentFindingMap = new Map(currentFindings.findings.map((item) => [item.fingerprint, item]));
  const previousFindingMap = new Map(previousFindings.findings.map((item) => [item.fingerprint, item]));
  const findingChanges = { new: [], persistent: [], resolved: [], reopened: [] };
  for (const [fingerprint, finding] of currentFindingMap) {
    const previousFinding = previousFindingMap.get(fingerprint);
    if (!previousFinding) findingChanges.new.push({ fingerprint, title: finding.title, severity: finding.severity });
    else findingChanges.persistent.push({ fingerprint, title: finding.title, severity: finding.severity });
  }
  for (const [fingerprint, finding] of previousFindingMap) if (!currentFindingMap.has(fingerprint)) findingChanges.resolved.push({ fingerprint, title: finding.title, severity: finding.severity });
  const previousTracker = (await details.listIssues(current.manifest.project.slug)).issues;
  for (const issue of previousTracker.filter((item) => item.verification === "reopened" && currentFindingMap.has(item.fingerprint))) findingChanges.reopened.push({ fingerprint: issue.fingerprint, title: issue.title, severity: issue.severity });
  const metricDelta = metricChanges(currentMetrics, previousMetrics);
  return { auditId: id, previousAuditId: previousSummary.id, comparable: true, pageChanges: pageChanges.slice(0, 500), metricChanges: metricDelta, findingChanges, counts: { pages: currentPages.total, changedPages: pageChanges.filter((item) => item.status !== "sin cambios").length, findings: currentFindings.findings.length } };
}
