#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProfileStore } from "./profile-store.mjs";
import { AuditStore } from "./audit-store.mjs";
import { ProjectSettingsStore } from "./project-settings-store.mjs";
import { AuditDetailStore } from "./audit-detail-store.mjs";
import { measureAuditStorage } from "./audit-storage.mjs";
import { AuditRunStore } from "./run-status.mjs";
import { getAuditChanges } from "./audit-history.mjs";

const server = new McpServer({ name: "seo-workspace", version: "1.0.0" });
const profiles = new ProfileStore();
const audits = new AuditStore();
const projectSettings = new ProjectSettingsStore();
const auditDetails = new AuditDetailStore();
const auditRuns = new AuditRunStore();
const success = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const safely = async (fn) => { try { return success(await fn()); } catch (error) { return { isError: true, content: [{ type: "text", text: error.message || String(error) }] }; } };

const serviceSchema = z.object({
  accountEmail: z.string().email().optional(),
  property: z.string().optional(),
  siteUrl: z.string().optional(),
  accountName: z.string().optional(),
  locationName: z.string().optional(),
});

const targetSchema = z.object({ operator: z.enum(["lte", "gte", "eq", "between"]), value: z.number(), warningValue: z.number().optional(), maxValue: z.number().optional() });
const periodSchema = z.object({ startDate: z.string(), endDate: z.string(), granularity: z.enum(["day", "week", "month", "snapshot", "none"]).optional() });
const kpiSchema = z.object({
  id: z.string(), label: z.string(), value: z.number(), previousValue: z.number().nullable().optional(),
  format: z.enum(["integer", "decimal", "percent", "duration-ms", "duration-s", "currency", "score"]).optional(), precision: z.number().int().min(0).max(4).optional(), unit: z.string().optional(),
  policy: z.enum(["higher-is-better", "lower-is-better", "informational"]).optional(), target: targetSchema.optional(),
  formatted: z.string().optional(), previousFormatted: z.string().nullable().optional(), sentiment: z.enum(["positive", "negative", "neutral", "warning"]).optional(),
  source: z.string(), context: z.string().nullable().optional(), datasetId: z.string().nullable().optional(), datasetSeriesKey: z.string().nullable().optional(),
});
const seriesSchema = z.object({ key: z.string(), label: z.string(), unit: z.string().optional(), color: z.enum(["lime", "blue", "orange", "green", "red", "ink"]).optional(), axis: z.enum(["left", "right"]).optional(), aggregation: z.enum(["sum", "average", "weighted-average", "last"]).optional(), weightKey: z.string().optional() });
const valuesSchema = z.record(z.string(), z.number().nullable());
const datasetSchema = z.object({
  id: z.string(), type: z.enum(["timeseries", "categorical", "matrix"]), title: z.string().optional(), source: z.string(), granularity: z.enum(["day", "week", "month", "snapshot", "none"]).optional(), series: z.array(seriesSchema),
  rows: z.array(z.union([z.object({ date: z.string(), values: valuesSchema }), z.object({ label: z.string(), values: valuesSchema }), z.object({ x: z.string(), y: z.string(), value: z.number() })])),
});
const chartSchema = z.object({
  id: z.string(), title: z.string(), type: z.enum(["line", "area", "bar", "stacked-bar", "donut", "scatter", "heatmap"]), description: z.string().optional(),
  section: z.enum(["summary", "visibility", "traffic", "local", "technical", "content"]).optional(), datasetId: z.string(), seriesKeys: z.array(z.string()).optional(), compareMode: z.enum(["none", "previous-period"]).optional(),
  annotations: z.array(z.object({ date: z.string().optional(), label: z.string(), type: z.enum(["audit", "change", "warning"]).optional() })).optional(),
});
const actionSchema = z.object({ title: z.string(), why: z.string(), steps: z.array(z.string()).optional(), validation: z.string(), ownerRole: z.string().optional(), effort: z.enum(["xs", "s", "m", "l", "xl"]).optional() });
const findingSchema = z.object({
  id: z.string().optional(), ruleId: z.string(), scope: z.enum(["global", "page", "resource"]).optional(), severity: z.enum(["p0", "p1", "p2", "p3", "info"]), category: z.string().optional(),
  title: z.string(), explanation: z.string(), evidence: z.string(), impact: z.string(), affectedUrls: z.array(z.string()).optional(), resources: z.array(z.string()).optional(), source: z.string(), confidence: z.enum(["high", "medium", "low"]).optional(), actions: z.array(actionSchema).optional(), observedAt: z.string().optional(),
});
const diagnosticSchema = z.object({ code: z.string(), stage: z.string().optional(), source: z.string(), scope: z.string().optional(), message: z.string(), retryable: z.boolean().optional(), completenessImpact: z.string(), nextAction: z.string(), attemptedAt: z.string().optional() });
const pageSchema = z.object({
  url: z.string(), canonicalUrl: z.string().nullable().optional(), discoverySources: z.array(z.string()).optional(), sitemapUrls: z.array(z.string()).optional(), template: z.string().optional(), locale: z.string().optional(), depth: z.number().optional(), auditLevel: z.enum(["light", "deep"]).optional(), coverage: z.enum(["complete", "partial", "none"]).optional(), issueCounts: z.record(z.string(), z.number()).optional(), findingIds: z.array(z.string()).optional(), fetchedAt: z.string().optional(),
  response: z.record(z.string(), z.unknown()).optional(), indexability: z.record(z.string(), z.unknown()).optional(), metadata: z.record(z.string(), z.unknown()).optional(), links: z.record(z.string(), z.unknown()).optional(), images: z.record(z.string(), z.unknown()).optional(), schemas: z.record(z.string(), z.unknown()).optional(), performance: z.record(z.string(), z.unknown()).optional(), searchConsole: z.record(z.string(), z.unknown()).optional(), analytics: z.record(z.string(), z.unknown()).optional(), screenshots: z.array(z.object({ label: z.string(), path: z.string() })).optional(), diagnostics: z.array(z.record(z.string(), z.unknown())).optional(), metrics: z.record(z.string(), z.unknown()).optional(),
  expectedLocale: z.string().optional(), declaredLocale: z.string().optional(), aliases: z.array(z.string()).optional(), healthReason: z.string().optional(), evidence: z.record(z.string(), z.unknown()).optional(),
});

server.registerTool("manage_google_profiles", {
  title: "Gestionar perfiles Google",
  description: "Lista, crea, actualiza, selecciona o elimina perfiles conjuntos. Eliminar un perfil no revoca credenciales.",
  inputSchema: {
    action: z.enum(["list", "get", "upsert", "set-default", "remove"]),
    profileId: z.string().optional(),
    name: z.string().optional(),
    setDefault: z.boolean().optional().default(false),
    services: z.object({ analytics: serviceSchema.optional(), searchConsole: serviceSchema.optional(), businessProfile: serviceSchema.optional() }).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, ({ action, profileId, name, setDefault, services }) => safely(async () => {
  if (action === "list") return profiles.list();
  if (action === "get") return (await profiles.get(profileId)).profile;
  if (action === "upsert") return profiles.upsert({ id: profileId, name, services, setDefault });
  if (action === "set-default") return profiles.setDefault(profileId);
  return profiles.remove(profileId);
}));

server.registerTool("save_audit_result", {
  title: "Guardar resultado de auditoría",
  description: "Guarda un informe Markdown, KPIs y gráficas estructuradas en el almacén privado local del plugin.",
  inputSchema: {
    id: z.string().optional(), title: z.string().min(1),
    project: z.object({ slug: z.string(), name: z.string().min(1) }),
    profileId: z.string().optional(), auditType: z.string().optional(),
    status: z.enum(["draft", "completed", "failed"]).optional(), score: z.number().min(0).max(100).nullable().optional(),
    summary: z.string().optional(), executive: z.object({ state: z.string().optional(), change: z.string().optional(), priorities: z.array(z.object({ title: z.string(), why: z.string(), validation: z.string(), findingId: z.string().nullable().optional() })).max(5).optional() }).optional(), skillsUsed: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
    periods: z.object({ primary: periodSchema.optional(), comparison: periodSchema.optional(), history: periodSchema.optional() }).optional(),
    sourceCoverage: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["available", "partial", "unavailable"]), detail: z.string().optional(), updatedAt: z.string().nullable().optional() })).optional(),
    kpis: z.array(kpiSchema).optional(), datasets: z.array(datasetSchema).optional(), charts: z.array(chartSchema).optional(),
    reportMarkdown: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, (input) => safely(() => audits.save(input)));

server.registerTool("save_audit_findings", {
  title: "Guardar hallazgos estructurados",
  description: "Guarda el conjunto completo de hallazgos de un snapshot draft y sincroniza su seguimiento persistente por proyecto.",
  inputSchema: { auditId: z.string(), findings: z.array(findingSchema).max(1000) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId, findings }) => safely(() => auditDetails.saveFindings(auditId, findings)));

server.registerTool("save_audit_inventory", {
  title: "Guardar inventario técnico",
  description: "Guarda sitemaps, robots, manifests, feeds, archivos para agentes, schema, recursos críticos y diagnósticos de recopilación.",
  inputSchema: { auditId: z.string(), inventory: z.record(z.string(), z.unknown()), diagnostics: z.array(diagnosticSchema).max(500).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId, inventory, diagnostics }) => safely(() => auditDetails.saveInventory(auditId, inventory, diagnostics)));

server.registerTool("save_audit_page_batch", {
  title: "Guardar lote de páginas auditadas",
  description: "Guarda entre 1 y 25 páginas; el snapshot admite hasta 500 páginas ligeras y 50 profundas.",
  inputSchema: { auditId: z.string(), pages: z.array(pageSchema).min(1).max(25) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId, pages }) => safely(() => auditDetails.savePageBatch(auditId, pages)));

server.registerTool("list_audit_pages", {
  title: "Listar páginas de una auditoría",
  description: "Lista y pagina URLs con filtros de sitemap, plantilla, idioma, indexabilidad, cobertura y salud.",
  inputSchema: { auditId: z.string(), query: z.string().optional(), sitemap: z.string().optional(), template: z.string().optional(), locale: z.string().optional(), indexability: z.enum(["indexable", "blocked"]).optional(), coverage: z.enum(["complete", "partial", "none"]).optional(), health: z.enum(["critical", "issues", "healthy", "unknown"]).optional(), sort: z.enum(["url", "status", "health", "clicks", "sessions"]).optional(), order: z.enum(["asc", "desc"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId, ...filters }) => safely(() => auditDetails.listPages(auditId, filters)));

server.registerTool("get_audit_page", {
  title: "Consultar detalle de una página",
  description: "Devuelve evidencia, métricas, capturas y hallazgos relacionados de una URL auditada.",
  inputSchema: { auditId: z.string(), pageId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId, pageId }) => safely(() => auditDetails.getPage(auditId, pageId)));

server.registerTool("get_audit_storage", {
  title: "Medir almacenamiento de auditoría",
  description: "Mide el espacio ocupado por un snapshot y su desglose privado. La cuota fija es de 512 MB.",
  inputSchema: { auditId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId }) => safely(() => measureAuditStorage(auditId)));

server.registerTool("get_audit_run_status", {
  title: "Consultar estado de auditoría",
  description: "Devuelve la fase, progreso y diagnósticos de una auditoría reanudable.",
  inputSchema: { auditId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId }) => safely(() => auditRuns.get(auditId)));

server.registerTool("get_audit_changes", {
  title: "Comparar auditorías",
  description: "Compara una auditoría con el snapshot anterior del mismo proyecto por URL, incidencia y señal técnica.",
  inputSchema: { auditId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ auditId }) => safely(() => getAuditChanges(auditId)));

server.registerTool("manage_finding_workflow", {
  title: "Gestionar seguimiento de incidencias",
  description: "Lista, consulta o actualiza estado, responsable, fecha, notas y aceptación de riesgo sin modificar el snapshot original.",
  inputSchema: { action: z.enum(["list", "get", "update"]), projectId: z.string(), fingerprint: z.string().optional(), status: z.enum(["pending", "in_progress", "resolved", "accepted"]).optional(), owner: z.string().optional(), dueDate: z.string().nullable().optional(), note: z.string().optional(), acceptanceReason: z.string().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, (input) => safely(() => auditDetails.manageWorkflow(input)));

server.registerTool("list_audit_results", {
  title: "Listar auditorías",
  description: "Consulta los manifiestos privados con filtros de proyecto, fecha, tipo, estado y texto.",
  inputSchema: { query: z.string().optional(), project: z.string().optional(), status: z.enum(["draft", "completed", "failed"]).optional(), auditType: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), latestOnly: z.boolean().optional(), order: z.enum(["asc", "desc"]).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, (filters) => safely(async () => ({ audits: await audits.list(filters) })));

server.registerTool("get_audit_result", {
  title: "Consultar auditoría",
  description: "Devuelve el manifiesto y el informe Markdown de una auditoría privada.",
  inputSchema: { id: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ id }) => safely(() => audits.get(id)));

server.registerTool("manage_seo_project_settings", {
  title: "Gestionar objetivos SEO del proyecto",
  description: "Lista, consulta o actualiza zona horaria, moneda y objetivos privados por proyecto.",
    inputSchema: { action: z.enum(["list", "get", "upsert"]), projectId: z.string().optional(), timezone: z.string().optional(), currency: z.string().optional(), targets: z.record(z.string(), targetSchema.nullable()).optional(), allowPrivateHosts: z.boolean().optional(), canonicalUrl: z.string().nullable().optional(), localeMap: z.record(z.string(), z.string()).optional(), crawlExclusions: z.array(z.string()).optional(), lighthouseBudget: z.object({ maxPages: z.number().int().min(0).max(10).optional(), maxRepeats: z.number().int().min(1).max(3).optional() }).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ action, projectId, timezone, currency, targets, allowPrivateHosts, canonicalUrl, localeMap, crawlExclusions, lighthouseBudget }) => safely(async () => {
  if (action === "list") return projectSettings.list();
  if (action === "get") return projectSettings.resolved(projectId);
  return projectSettings.upsert({ id: projectId, timezone, currency, targets, allowPrivateHosts, canonicalUrl, localeMap, crawlExclusions, lighthouseBudget });
}));

server.registerTool("get_project_history", {
  title: "Consultar evolución SEO del proyecto",
  description: "Devuelve snapshots y KPIs históricos de un proyecto sin exponer informes de otros proyectos.",
  inputSchema: { projectId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ projectId }) => safely(() => audits.projectHistory(projectId)));

await server.connect(new StdioServerTransport());
