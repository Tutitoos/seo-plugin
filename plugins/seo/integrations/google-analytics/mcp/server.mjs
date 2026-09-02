#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleAnalyticsClient } from "./lib/google-analytics-api.mjs";
import { MacOSKeychain } from "./lib/keychain.mjs";
import { GoogleOAuthManager } from "./lib/oauth.mjs";
import { ProfileStore, resolveServiceProfile } from "../../../src/profile-store.mjs";
import { ScopedKeychain } from "../../../src/scoped-keychain.mjs";

const server = new McpServer({ name: "google-analytics", version: "0.1.0" });
const profiles = new ProfileStore();
const baseKeychain = new MacOSKeychain();

async function context(profileId, explicitEmail) {
  const resolved = await resolveServiceProfile(profileId, "analytics", profiles);
  const accountEmail = explicitEmail || resolved.service.accountEmail;
  if (!accountEmail) throw new Error(`El perfil ${resolved.profile.id} no tiene cuenta de Analytics.`);
  const oauth = new GoogleOAuthManager({ keychain: new ScopedKeychain(baseKeychain, accountEmail) });
  return { ...resolved, accountEmail, oauth, google: new GoogleAnalyticsClient({ oauth }) };
}

function success(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function failure(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

async function safely(handler) {
  try { return success(await handler()); } catch (error) { return failure(error); }
}

const propertySchema = z.string().regex(/^properties\/\d+$/, "property debe usar el formato properties/123456789.");
const apiNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Usa un nombre API de Analytics válido.");
const dateSchema = z.string().regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|[1-9]\d*daysAgo)$/, "Usa YYYY-MM-DD, today, yesterday o NdaysAgo.");

const stringFilterSchema = z.object({
  fieldName: apiNameSchema,
  matchType: z.enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"]).optional().default("EXACT"),
  value: z.string().max(4096),
  caseSensitive: z.boolean().optional().default(false),
});

const numericFilterSchema = z.object({
  fieldName: apiNameSchema,
  operation: z.enum(["EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL"]),
  value: z.number(),
});

function andExpression(expressions) {
  if (!expressions.length) return undefined;
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

function dimensionFilter(filters) {
  return andExpression(filters.map((filter) => ({
    filter: {
      fieldName: filter.fieldName,
      stringFilter: { matchType: filter.matchType, value: filter.value, caseSensitive: filter.caseSensitive },
    },
  })));
}

function metricFilter(filters) {
  return andExpression(filters.map((filter) => ({
    filter: {
      fieldName: filter.fieldName,
      numericFilter: { operation: filter.operation, value: { doubleValue: filter.value } },
    },
  })));
}

function normalizeReport(data, dimensions, metrics, offset, limit) {
  const rows = (data.rows || []).map((row) => ({
    dimensions: Object.fromEntries(dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value ?? null])),
    metrics: Object.fromEntries(metrics.map((name, index) => [name, row.metricValues?.[index]?.value ?? null])),
  }));
  const rowCount = Number(data.rowCount || rows.length);
  const next = offset + rows.length;
  return {
    rows,
    returnedRows: rows.length,
    totalRows: rowCount,
    nextOffset: next < rowCount && rows.length === limit ? next : null,
    totals: data.totals || [],
    maximums: data.maximums || [],
    minimums: data.minimums || [],
    metadata: data.metadata || null,
    propertyQuota: data.propertyQuota || null,
  };
}

server.registerTool(
  "manage_analytics_connection",
  {
    title: "Gestionar conexión de Google Analytics",
    description: "Conecta, verifica o desconecta una cuenta de Google para GA4. La primera conexión requiere un JSON OAuth de escritorio.",
    inputSchema: {
      action: z.enum(["connect", "status", "disconnect"]),
      credentialsFile: z.string().optional().describe("Ruta absoluta al JSON OAuth de Aplicación de escritorio."),
      forceAccountSelection: z.boolean().optional().default(false),
      preferredAccountEmail: z.string().email().optional().describe("Cuenta que Google debe autorizar; otra cuenta no se guardará."),
      profileId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ action, credentialsFile, forceAccountSelection, preferredAccountEmail, profileId }) => safely(async () => {
    const ctx = await context(profileId, preferredAccountEmail);
    if (action === "status") return { profileId: ctx.profile.id, ...(await ctx.oauth.status()) };
    if (action === "disconnect") return { profileId: ctx.profile.id, ...(await ctx.oauth.disconnect()) };
    const result = await ctx.oauth.connect({ credentialsFile, forceAccountSelection, preferredAccountEmail: ctx.accountEmail });
    await profiles.bindService(ctx.profile.id, "analytics", { accountEmail: result.accountEmail });
    return { profileId: ctx.profile.id, ...result };
  }),
);

server.registerTool(
  "list_analytics_properties",
  {
    title: "Listar cuentas y propiedades GA4",
    description: "Lista las cuentas y propiedades de Google Analytics accesibles para la cuenta conectada.",
    inputSchema: { profileId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId }) => safely(async () => {
    const { google } = await context(profileId);
    const data = await google.listAccountSummaries();
    return {
      accounts: data.accountSummaries.map((account) => ({
        account: account.account,
        displayName: account.displayName,
        properties: (account.propertySummaries || []).map((property) => ({
          property: property.property,
          displayName: property.displayName,
          propertyType: property.propertyType,
          parent: property.parent,
        })),
      })),
      truncated: Boolean(data.nextPageToken),
    };
  }),
);

server.registerTool(
  "get_analytics_metadata",
  {
    title: "Consultar dimensiones y métricas GA4",
    description: "Obtiene los nombres API, descripciones y compatibilidad de las dimensiones y métricas disponibles para una propiedad.",
    inputSchema: { profileId: z.string().optional(), property: propertySchema.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, property }) => safely(async () => {
    const ctx = await context(profileId);
    property ||= ctx.service.property;
    if (!property) throw new Error(`El perfil ${ctx.profile.id} no tiene propiedad GA4 predeterminada.`);
    const { google } = ctx;
    const data = await google.getMetadata(property);
    return {
      property,
      dimensions: (data.dimensions || []).map(({ apiName, uiName, description, category, deprecatedApiNames, customDefinition }) => ({ apiName, uiName, description, category, deprecatedApiNames, customDefinition })),
      metrics: (data.metrics || []).map(({ apiName, uiName, description, category, type, expression, incompatibleMetrics, deprecatedApiNames, customDefinition }) => ({ apiName, uiName, description, category, type, expression, incompatibleMetrics, deprecatedApiNames, customDefinition })),
    };
  }),
);

server.registerTool(
  "run_analytics_report",
  {
    title: "Ejecutar informe histórico GA4",
    description: "Consulta dimensiones y métricas históricas de una propiedad GA4 con filtros AND simples y paginación.",
    inputSchema: {
      profileId: z.string().optional(),
      property: propertySchema.optional(),
      startDate: dateSchema,
      endDate: dateSchema,
      dimensions: z.array(apiNameSchema).max(9).optional().default([]),
      metrics: z.array(apiNameSchema).min(1).max(10),
      dimensionFilters: z.array(stringFilterSchema).max(10).optional().default([]),
      metricFilters: z.array(numericFilterSchema).max(10).optional().default([]),
      orderBy: z.object({ fieldName: apiNameSchema, type: z.enum(["dimension", "metric"]), descending: z.boolean().optional().default(true) }).optional(),
      keepEmptyRows: z.boolean().optional().default(false),
      returnPropertyQuota: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(100000).optional().default(1000),
      offset: z.number().int().min(0).optional().default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, property, startDate, endDate, dimensions, metrics, dimensionFilters, metricFilters, orderBy, keepEmptyRows, returnPropertyQuota, limit, offset }) => safely(async () => {
    const ctx = await context(profileId);
    property ||= ctx.service.property;
    if (!property) throw new Error(`El perfil ${ctx.profile.id} no tiene propiedad GA4 predeterminada.`);
    const { google } = ctx;
    if (/^\d/.test(startDate) && /^\d/.test(endDate) && startDate > endDate) throw new Error("startDate debe ser anterior o igual a endDate.");
    if (new Set(dimensions).size !== dimensions.length || new Set(metrics).size !== metrics.length) throw new Error("No repitas dimensiones o métricas.");
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      keepEmptyRows,
      returnPropertyQuota,
      limit: String(limit),
      offset: String(offset),
      ...(dimensionFilters.length ? { dimensionFilter: dimensionFilter(dimensionFilters) } : {}),
      ...(metricFilters.length ? { metricFilter: metricFilter(metricFilters) } : {}),
      ...(orderBy ? { orderBys: [{ desc: orderBy.descending, ...(orderBy.type === "dimension" ? { dimension: { dimensionName: orderBy.fieldName } } : { metric: { metricName: orderBy.fieldName } }) }] } : {}),
    };
    const data = await google.runReport(property, body);
    return { property, startDate, endDate, ...normalizeReport(data, dimensions, metrics, offset, limit) };
  }),
);

server.registerTool(
  "run_analytics_realtime_report",
  {
    title: "Ejecutar informe en tiempo real GA4",
    description: "Consulta usuarios, eventos y otras métricas en tiempo real compatibles con la propiedad GA4.",
    inputSchema: {
      profileId: z.string().optional(),
      property: propertySchema.optional(),
      dimensions: z.array(apiNameSchema).max(4).optional().default([]),
      metrics: z.array(apiNameSchema).min(1).max(4),
      dimensionFilters: z.array(stringFilterSchema).max(10).optional().default([]),
      metricFilters: z.array(numericFilterSchema).max(10).optional().default([]),
      limit: z.number().int().min(1).max(100000).optional().default(1000),
      returnPropertyQuota: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, property, dimensions, metrics, dimensionFilters, metricFilters, limit, returnPropertyQuota }) => safely(async () => {
    const ctx = await context(profileId);
    property ||= ctx.service.property;
    if (!property) throw new Error(`El perfil ${ctx.profile.id} no tiene propiedad GA4 predeterminada.`);
    const { google } = ctx;
    if (new Set(dimensions).size !== dimensions.length || new Set(metrics).size !== metrics.length) throw new Error("No repitas dimensiones o métricas.");
    const body = {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: String(limit),
      returnPropertyQuota,
      ...(dimensionFilters.length ? { dimensionFilter: dimensionFilter(dimensionFilters) } : {}),
      ...(metricFilters.length ? { metricFilter: metricFilter(metricFilters) } : {}),
    };
    const data = await google.runRealtimeReport(property, body);
    return { property, ...normalizeReport(data, dimensions, metrics, 0, limit) };
  }),
);

await server.connect(new StdioServerTransport());
