#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleBusinessProfileClient } from "./lib/google-business-api.mjs";
import { MacOSKeychain } from "./lib/keychain.mjs";
import { GoogleOAuthManager } from "./lib/oauth.mjs";
import { ProfileStore, resolveServiceProfile } from "../../../src/profile-store.mjs";
import { ScopedKeychain } from "../../../src/scoped-keychain.mjs";

const server = new McpServer({ name: "google-business-profile", version: "0.1.0" });
const profiles = new ProfileStore();
const baseKeychain = new MacOSKeychain();

async function context(profileId, explicitEmail) {
  const resolved = await resolveServiceProfile(profileId, "businessProfile", profiles);
  const accountEmail = explicitEmail || resolved.service.accountEmail;
  if (!accountEmail) throw new Error(`El perfil ${resolved.profile.id} no tiene cuenta de Business Profile.`);
  const oauth = new GoogleOAuthManager({ keychain: new ScopedKeychain(baseKeychain, accountEmail) });
  return { ...resolved, accountEmail, oauth, google: new GoogleBusinessProfileClient({ oauth }) };
}

const accountNameSchema = z.string().regex(/^accounts\/(?:-|\d+)$/, "Usa accounts/{id} o accounts/-.");
const locationNameSchema = z.string().regex(/^locations\/\d+$/, "Usa locations/{id}.");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
  "La fecha debe existir y usar YYYY-MM-DD.",
);

const defaultReadMask = [
  "name",
  "title",
  "storeCode",
  "languageCode",
  "phoneNumbers",
  "categories",
  "storefrontAddress",
  "websiteUri",
  "regularHours",
  "specialHours",
  "serviceArea",
  "labels",
  "metadata",
  "openInfo",
  "profile",
  "relationshipData",
  "moreHours",
  "serviceItems",
].join(",");

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
    structuredContent: { error: { code: error?.code || "business-profile-error", message: error instanceof Error ? error.message : String(error), status: error?.status || null, retryable: Boolean(error?.retryable), nextAction: error?.nextAction || null } },
  };
}

async function safely(handler) {
  try { return success(await handler()); } catch (error) { return failure(error); }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

server.registerTool(
  "manage_business_profile_connection",
  {
    title: "Gestionar conexión de Google Business Profile",
    description: "Conecta, verifica o desconecta una cuenta independiente de Google. La conexión permite elegir cuenta y puede exigir que el correo autorizado coincida exactamente con el esperado.",
    inputSchema: {
      action: z.enum(["connect", "status", "disconnect"]),
      credentialsFile: z.string().optional().describe("Ruta absoluta al JSON OAuth de una Aplicación de escritorio. Solo se usa al conectar."),
      forceAccountSelection: z.boolean().optional().default(false).describe("Permite sustituir una cuenta ya conectada y muestra el selector de Google."),
      preferredAccountEmail: z.string().email().optional().describe("Cuenta que Google debe autorizar. Si se elige otra, el plugin no guarda la sesión."),
      profileId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ action, credentialsFile, forceAccountSelection, preferredAccountEmail, profileId }) => safely(async () => {
    const ctx = await context(profileId, preferredAccountEmail);
    if (action === "status") return { profileId: ctx.profile.id, ...(await ctx.oauth.status()) };
    if (action === "disconnect") return { profileId: ctx.profile.id, ...(await ctx.oauth.disconnect()) };
    const result = await ctx.oauth.connect({ credentialsFile, forceAccountSelection, preferredAccountEmail: ctx.accountEmail });
    await profiles.bindService(ctx.profile.id, "businessProfile", { accountEmail: result.accountEmail });
    return { profileId: ctx.profile.id, ...result };
  }),
);

server.registerTool(
  "list_business_profile_accounts",
  {
    title: "Listar cuentas de Business Profile",
    description: "Lista las cuentas personales, grupos y organizaciones de Google Business Profile accesibles para la cuenta conectada.",
    inputSchema: {
      pageSize: z.number().int().min(1).max(20).optional().default(20),
      pageToken: z.string().min(1).optional(),
      accountType: z.enum(["PERSONAL", "LOCATION_GROUP", "USER_GROUP", "ORGANIZATION"]).optional(),
      profileId: z.string().optional(),
    },
    annotations: readOnly,
  },
  ({ pageSize, pageToken, accountType, profileId }) => safely(async () => {
    const { google } = await context(profileId);
    const data = await google.listAccounts({
      pageSize,
      pageToken,
      ...(accountType ? { filter: `type=${accountType}` } : {}),
    });
    return { accounts: data.accounts || [], nextPageToken: data.nextPageToken || null };
  }),
);

server.registerTool(
  "list_business_profile_locations",
  {
    title: "Listar fichas de negocio",
    description: "Lista las ubicaciones de una cuenta. Usa accounts/- para incluir fichas gestionadas indirectamente mediante grupos.",
    inputSchema: {
      profileId: z.string().optional(),
      accountName: accountNameSchema.optional(),
      pageSize: z.number().int().min(1).max(100).optional().default(100),
      pageToken: z.string().min(1).optional(),
      filter: z.string().min(1).max(1000).optional(),
      orderBy: z.enum(["title", "storeCode"]).optional(),
    },
    annotations: readOnly,
  },
  ({ profileId, accountName, pageSize, pageToken, filter, orderBy }) => safely(async () => {
    const ctx = await context(profileId);
    accountName ||= ctx.service.accountName;
    if (!accountName) throw new Error(`El perfil ${ctx.profile.id} no tiene accountName predeterminado.`);
    const { google } = ctx;
    const data = await google.listLocations({ accountName, pageSize, pageToken, filter, orderBy, readMask: defaultReadMask });
    return { accountName, locations: data.locations || [], nextPageToken: data.nextPageToken || null };
  }),
);

server.registerTool(
  "get_business_profile_location",
  {
    title: "Consultar una ficha de negocio",
    description: "Devuelve los datos actuales de una ubicación: nombre, categorías, teléfonos, web, dirección, horarios, área de servicio, apertura y metadatos.",
    inputSchema: { profileId: z.string().optional(), locationName: locationNameSchema.optional() },
    annotations: readOnly,
  },
  ({ profileId, locationName }) => safely(async () => {
    const ctx = await context(profileId);
    locationName ||= ctx.service.locationName;
    if (!locationName) throw new Error(`El perfil ${ctx.profile.id} no tiene locationName predeterminado.`);
    return { location: await ctx.google.getLocation({ locationName, readMask: defaultReadMask }) };
  }),
);

server.registerTool(
  "list_business_profile_reviews",
  {
    title: "Listar reseñas de una ficha",
    description: "Devuelve reseñas de una ubicación verificada, junto con valoración media, total y paginación. No responde ni modifica reseñas.",
    inputSchema: {
      profileId: z.string().optional(),
      accountName: z.string().regex(/^accounts\/\d+$/, "Usa accounts/{id}.").optional(),
      locationName: locationNameSchema.optional(),
      pageSize: z.number().int().min(1).max(50).optional().default(50),
      pageToken: z.string().min(1).optional(),
      orderBy: z.enum(["rating", "rating desc", "updateTime desc"]).optional().default("updateTime desc"),
    },
    annotations: readOnly,
  },
  ({ profileId, accountName, locationName, pageSize, pageToken, orderBy }) => safely(async () => {
    const ctx = await context(profileId);
    accountName ||= ctx.service.accountName;
    locationName ||= ctx.service.locationName;
    if (!accountName || !locationName) throw new Error(`El perfil ${ctx.profile.id} necesita accountName y locationName.`);
    const { google } = ctx;
    const data = await google.listReviews({ accountName, locationName, pageSize, pageToken, orderBy });
    return {
      accountName,
      locationName,
      averageRating: data.averageRating ?? null,
      totalReviewCount: data.totalReviewCount ?? null,
      reviews: data.reviews || [],
      nextPageToken: data.nextPageToken || null,
    };
  }),
);

server.registerTool(
  "list_business_profile_media",
  {
    title: "Listar imágenes de Business Profile",
    description: "Lista imágenes del propietario o aportadas por clientes. Devuelve URLs temporales de Google; no modifica la galería.",
    inputSchema: {
      profileId: z.string().optional(), accountName: z.string().regex(/^accounts\/\d+$/, "Usa accounts/{id}.").optional(), locationName: locationNameSchema.optional(),
      source: z.enum(["owner", "customer"]).optional().default("owner"), pageSize: z.number().int().min(1).max(100).optional().default(100), pageToken: z.string().min(1).optional(),
    },
    annotations: readOnly,
  },
  ({ profileId, accountName, locationName, source, pageSize, pageToken }) => safely(async () => {
    const ctx = await context(profileId);
    accountName ||= ctx.service.accountName; locationName ||= ctx.service.locationName;
    if (!accountName || !locationName) throw new Error(`El perfil ${ctx.profile.id} necesita accountName y locationName.`);
    const data = await ctx.google.listMedia({ accountName, locationName, source, pageSize, pageToken });
    return { profileId: ctx.profile.id, accountName, locationName, source, mediaItems: data.mediaItems || [], nextPageToken: data.nextPageToken || null, totalMediaItemCount: data.totalMediaItemCount ?? null };
  }),
);

server.registerTool(
  "list_business_profile_posts",
  {
    title: "Listar publicaciones de Business Profile",
    description: "Lista publicaciones recientes de una ubicación con su estado, CTA, fechas y medios. No crea ni edita publicaciones.",
    inputSchema: { profileId: z.string().optional(), accountName: z.string().regex(/^accounts\/\d+$/, "Usa accounts/{id}.").optional(), locationName: locationNameSchema.optional(), pageSize: z.number().int().min(1).max(100).optional().default(20), pageToken: z.string().min(1).optional() },
    annotations: readOnly,
  },
  ({ profileId, accountName, locationName, pageSize, pageToken }) => safely(async () => {
    const ctx = await context(profileId);
    accountName ||= ctx.service.accountName; locationName ||= ctx.service.locationName;
    if (!accountName || !locationName) throw new Error(`El perfil ${ctx.profile.id} necesita accountName y locationName.`);
    const data = await ctx.google.listLocalPosts({ accountName, locationName, pageSize, pageToken });
    return { profileId: ctx.profile.id, accountName, locationName, localPosts: data.localPosts || [], nextPageToken: data.nextPageToken || null };
  }),
);

server.registerTool(
  "get_business_profile_attributes",
  {
    title: "Consultar atributos de Business Profile",
    description: "Devuelve los atributos declarados por una ubicación, como accesibilidad, pagos o servicios disponibles.",
    inputSchema: { profileId: z.string().optional(), locationName: locationNameSchema.optional() },
    annotations: readOnly,
  },
  ({ profileId, locationName }) => safely(async () => {
    const ctx = await context(profileId);
    locationName ||= ctx.service.locationName;
    if (!locationName) throw new Error(`El perfil ${ctx.profile.id} no tiene locationName predeterminado.`);
    const data = await ctx.google.getAttributes({ locationName });
    return { profileId: ctx.profile.id, locationName, attributes: data.attributes || [] };
  }),
);

const dailyMetric = z.enum([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
]);

server.registerTool(
  "query_business_profile_performance",
  {
    title: "Consultar rendimiento de una ficha",
    description: "Consulta series diarias de visibilidad e interacciones para una ubicación y fechas explícitas.",
    inputSchema: {
      profileId: z.string().optional(),
      locationName: locationNameSchema.optional(),
      startDate: dateSchema,
      endDate: dateSchema,
      dailyMetrics: z.array(dailyMetric).min(1).max(11),
    },
    annotations: readOnly,
  },
  ({ profileId, locationName, startDate, endDate, dailyMetrics }) => safely(async () => {
    const ctx = await context(profileId);
    locationName ||= ctx.service.locationName;
    if (!locationName) throw new Error(`El perfil ${ctx.profile.id} no tiene locationName predeterminado.`);
    const { google } = ctx;
    if (startDate > endDate) throw new Error("startDate debe ser anterior o igual a endDate.");
    if (new Set(dailyMetrics).size !== dailyMetrics.length) throw new Error("No repitas métricas en la misma consulta.");
    const data = await google.fetchPerformance({ locationName, dailyMetrics, startDate, endDate });
    return {
      locationName,
      startDate,
      endDate,
      metricTimeSeries: data.multiDailyMetricTimeSeries || [],
    };
  }),
);

await server.connect(new StdioServerTransport());
