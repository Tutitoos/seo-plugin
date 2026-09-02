#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProfileStore } from "./profile-store.mjs";
import { AuditStore } from "./audit-store.mjs";
import { ProjectSettingsStore } from "./project-settings-store.mjs";

const server = new McpServer({ name: "seo-workspace", version: "1.0.0" });
const profiles = new ProfileStore();
const audits = new AuditStore();
const projectSettings = new ProjectSettingsStore();
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
    summary: z.string().optional(), skillsUsed: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
    periods: z.object({ primary: periodSchema.optional(), comparison: periodSchema.optional(), history: periodSchema.optional() }).optional(),
    sourceCoverage: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["available", "partial", "unavailable"]), detail: z.string().optional(), updatedAt: z.string().nullable().optional() })).optional(),
    kpis: z.array(kpiSchema).optional(), datasets: z.array(datasetSchema).optional(), charts: z.array(chartSchema).optional(),
    reportMarkdown: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, (input) => safely(() => audits.save(input)));

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
  inputSchema: { action: z.enum(["list", "get", "upsert"]), projectId: z.string().optional(), timezone: z.string().optional(), currency: z.string().optional(), targets: z.record(z.string(), targetSchema.nullable()).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ action, projectId, timezone, currency, targets }) => safely(async () => {
  if (action === "list") return projectSettings.list();
  if (action === "get") return projectSettings.resolved(projectId);
  return projectSettings.upsert({ id: projectId, timezone, currency, targets });
}));

server.registerTool("get_project_history", {
  title: "Consultar evolución SEO del proyecto",
  description: "Devuelve snapshots y KPIs históricos de un proyecto sin exponer informes de otros proyectos.",
  inputSchema: { projectId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ projectId }) => safely(() => audits.projectHistory(projectId)));

await server.connect(new StdioServerTransport());
