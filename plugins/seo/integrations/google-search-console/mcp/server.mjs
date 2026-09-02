#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MacOSKeychain } from "./lib/keychain.mjs";
import { GoogleOAuthManager } from "./lib/oauth.mjs";
import { GoogleSearchConsoleClient } from "./lib/google-api.mjs";
import { ProfileStore, resolveServiceProfile } from "../../../src/profile-store.mjs";
import { ScopedKeychain } from "../../../src/scoped-keychain.mjs";

const server = new McpServer({ name: "google-search-console", version: "0.1.0" });
const profiles = new ProfileStore();
const baseKeychain = new MacOSKeychain();

async function context(profileId, explicitEmail) {
  const resolved = await resolveServiceProfile(profileId, "searchConsole", profiles);
  const accountEmail = explicitEmail || resolved.service.accountEmail;
  if (!accountEmail) throw new Error(`El perfil ${resolved.profile.id} no tiene cuenta de Search Console.`);
  const oauth = new GoogleOAuthManager({ keychain: new ScopedKeychain(baseKeychain, accountEmail) });
  return { ...resolved, accountEmail, oauth, google: new GoogleSearchConsoleClient({ oauth }) };
}

const siteUrlSchema = z.string().min(1).refine(
  (value) => value.startsWith("sc-domain:") || value.startsWith("https://") || value.startsWith("http://"),
  "siteUrl debe ser exactamente una propiedad de Search Console: sc-domain:dominio o una URL http(s).",
);

function success(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

async function safely(handler) {
  try { return success(await handler()); } catch (error) { return failure(error); }
}

server.registerTool(
  "manage_google_connection",
  {
    title: "Gestionar conexión de Google Search Console",
    description: "Conecta, verifica o desconecta una cuenta de Google. La primera conexión requiere la ruta absoluta al JSON de un cliente OAuth de escritorio. Conectar abre el navegador; desconectar revoca el token.",
    inputSchema: {
      action: z.enum(["connect", "status", "disconnect"]),
      credentialsFile: z.string().optional().describe("Ruta absoluta al JSON OAuth de Aplicación de escritorio. Solo se usa al conectar."),
      forceAccountSelection: z.boolean().optional().default(false).describe("Muestra el selector de cuenta y permite sustituir la cuenta activa."),
      profileId: z.string().optional().describe("Perfil conjunto; se usa el predeterminado si se omite."),
      accountEmail: z.string().email().optional().describe("Cuenta que se conectará o consultará dentro del perfil."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  ({ action, credentialsFile, forceAccountSelection, profileId, accountEmail }) => safely(async () => {
    const ctx = await context(profileId, accountEmail);
    if (action === "status") return { profileId: ctx.profile.id, ...(await ctx.oauth.status()) };
    if (action === "disconnect") return { profileId: ctx.profile.id, ...(await ctx.oauth.disconnect()) };
    const result = await ctx.oauth.connect({ credentialsFile, forceAccountSelection, preferredAccountEmail: ctx.accountEmail });
    await profiles.bindService(ctx.profile.id, "searchConsole", { accountEmail: result.accountEmail });
    return { profileId: ctx.profile.id, ...result };
  }),
);

server.registerTool(
  "list_search_console_sites",
  {
    title: "Listar propiedades de Search Console",
    description: "Lista las propiedades accesibles para la cuenta conectada y su nivel de permiso. Úsala antes de consultar cuando el siteUrl exacto no esté claro.",
    inputSchema: { profileId: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId }) => safely(async () => {
    const { google } = await context(profileId);
    const data = await google.listSites();
    return { sites: (data.siteEntry || []).map(({ siteUrl, permissionLevel }) => ({ siteUrl, permissionLevel })) };
  }),
);

const dimension = z.enum(["date", "query", "page", "country", "device", "searchAppearance"]);
const filterDimension = z.enum(["query", "page", "country", "device", "searchAppearance"]);
const operator = z.enum(["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"]);

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

server.registerTool(
  "query_search_performance",
  {
    title: "Consultar rendimiento de búsqueda",
    description: "Consulta clics, impresiones, CTR y posición de Search Analytics para una propiedad y periodo explícitos. Devuelve hasta 25.000 filas por llamada.",
    inputSchema: {
      profileId: z.string().optional(),
      siteUrl: siteUrlSchema.optional(),
      startDate: z.string().refine(validDate, "startDate debe usar YYYY-MM-DD."),
      endDate: z.string().refine(validDate, "endDate debe usar YYYY-MM-DD."),
      dimensions: z.array(dimension).max(6).optional().default([]),
      filters: z.array(z.object({
        dimension: filterDimension,
        operator: operator.optional().default("equals"),
        expression: z.string().min(1).max(4096),
      })).optional().default([]),
      searchType: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().default("web"),
      aggregationType: z.enum(["auto", "byPage", "byProperty"]).optional().default("auto"),
      rowLimit: z.number().int().min(1).max(25000).optional().default(1000),
      startRow: z.number().int().min(0).optional().default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, siteUrl, startDate, endDate, dimensions, filters, searchType, aggregationType, rowLimit, startRow }) => safely(async () => {
    const ctx = await context(profileId);
    siteUrl ||= ctx.service.siteUrl;
    if (!siteUrl) throw new Error(`El perfil ${ctx.profile.id} no tiene siteUrl predeterminado.`);
    const { google } = ctx;
    if (startDate > endDate) throw new Error("startDate debe ser anterior o igual a endDate.");
    if (new Set(dimensions).size !== dimensions.length) throw new Error("No repitas dimensiones en la misma consulta.");
    const usesPage = dimensions.includes("page") || filters.some((filter) => filter.dimension === "page");
    if (usesPage && aggregationType === "byProperty") {
      throw new Error("aggregationType=byProperty no es compatible con agrupar o filtrar por page.");
    }
    const query = {
      startDate,
      endDate,
      dimensions,
      type: searchType,
      aggregationType,
      rowLimit,
      startRow,
      ...(filters.length ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
    };
    const data = await google.queryPerformance(siteUrl, query);
    const rows = (data.rows || []).map((row) => ({
      dimensions: Object.fromEntries(dimensions.map((name, index) => [name, row.keys?.[index]])),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
    const mayHaveMore = rows.length === rowLimit;
    return {
      siteUrl,
      startDate,
      endDate,
      responseAggregationType: data.responseAggregationType,
      rows,
      rowCount: rows.length,
      mayHaveMore,
      nextStartRow: mayHaveMore ? startRow + rows.length : null,
    };
  }),
);

server.registerTool(
  "inspect_search_console_url",
  {
    title: "Inspeccionar URL indexada",
    description: "Consulta la información que Google tiene indexada para una URL. No realiza una prueba en vivo, no rastrea la URL y no solicita indexación.",
    inputSchema: {
      profileId: z.string().optional(),
      siteUrl: siteUrlSchema.optional(),
      inspectionUrl: z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://"), "inspectionUrl debe ser HTTP o HTTPS."),
      languageCode: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).optional().describe("Código BCP-47, por ejemplo es-ES."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, siteUrl, inspectionUrl, languageCode }) => safely(async () => {
    const ctx = await context(profileId);
    siteUrl ||= ctx.service.siteUrl;
    if (!siteUrl) throw new Error(`El perfil ${ctx.profile.id} no tiene siteUrl predeterminado.`);
    const { google } = ctx;
    const data = await google.inspectUrl(siteUrl, inspectionUrl, languageCode);
    return {
      siteUrl,
      inspectionUrl,
      source: "Google index",
      liveTest: false,
      inspectionResult: data.inspectionResult || null,
    };
  }),
);

server.registerTool(
  "list_search_console_sitemaps",
  {
    title: "Listar sitemaps de Search Console",
    description: "Lista los sitemaps conocidos por Search Console para una propiedad. Es de solo lectura: no envía ni elimina sitemaps.",
    inputSchema: {
      profileId: z.string().optional(),
      siteUrl: siteUrlSchema.optional(),
      sitemapIndex: z.string().url().optional().describe("URL opcional de un índice de sitemaps concreto."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ profileId, siteUrl, sitemapIndex }) => safely(async () => {
    const ctx = await context(profileId);
    siteUrl ||= ctx.service.siteUrl;
    if (!siteUrl) throw new Error(`El perfil ${ctx.profile.id} no tiene siteUrl predeterminado.`);
    const { google } = ctx;
    const data = await google.listSitemaps(siteUrl, sitemapIndex);
    return {
      siteUrl,
      sitemaps: (data.sitemap || []).map((item) => ({
        path: item.path,
        type: item.type,
        submitted: item.lastSubmitted,
        lastDownloaded: item.lastDownloaded,
        isPending: item.isPending,
        isSitemapsIndex: item.isSitemapsIndex,
        warnings: item.warnings,
        errors: item.errors,
        contents: item.contents || [],
      })),
    };
  }),
);

await server.connect(new StdioServerTransport());
