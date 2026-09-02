#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProfileStore } from "./profile-store.mjs";
import { AuditStore } from "./audit-store.mjs";

const server = new McpServer({ name: "seo-workspace", version: "1.0.0" });
const profiles = new ProfileStore();
const audits = new AuditStore();
const success = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const safely = async (fn) => { try { return success(await fn()); } catch (error) { return { isError: true, content: [{ type: "text", text: error.message || String(error) }] }; } };

const serviceSchema = z.object({
  accountEmail: z.string().email().optional(),
  property: z.string().optional(),
  siteUrl: z.string().optional(),
  accountName: z.string().optional(),
  locationName: z.string().optional(),
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
  description: "Guarda un informe Markdown y metadatos en el almacén privado local del plugin.",
  inputSchema: {
    id: z.string().optional(), title: z.string().min(1),
    project: z.object({ slug: z.string(), name: z.string().min(1) }),
    profileId: z.string().optional(), auditType: z.string().optional(),
    status: z.enum(["draft", "completed", "failed"]).optional(), score: z.number().min(0).max(100).nullable().optional(),
    summary: z.string().optional(), skillsUsed: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
    reportMarkdown: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, (input) => safely(() => audits.save(input)));

server.registerTool("list_audit_results", {
  title: "Listar auditorías",
  description: "Consulta los manifiestos privados con filtros de proyecto, fecha, tipo, estado y texto.",
  inputSchema: { query: z.string().optional(), project: z.string().optional(), status: z.enum(["draft", "completed", "failed"]).optional(), auditType: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, (filters) => safely(async () => ({ audits: await audits.list(filters) })));

server.registerTool("get_audit_result", {
  title: "Consultar auditoría",
  description: "Devuelve el manifiesto y el informe Markdown de una auditoría privada.",
  inputSchema: { id: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ id }) => safely(() => audits.get(id)));

await server.connect(new StdioServerTransport());
