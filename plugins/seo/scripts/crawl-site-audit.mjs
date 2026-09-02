#!/usr/bin/env node
import { AuditStore } from "../src/audit-store.mjs";
import { AuditDetailStore, normalizePageUrl } from "../src/audit-detail-store.mjs";
import { ProjectSettingsStore } from "../src/project-settings-store.mjs";
import { writeAuditJsonAtomic } from "../src/audit-storage.mjs";
import { getAuditChanges } from "../src/audit-history.mjs";
import { assertWebTarget } from "../src/url-policy.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((item) => { const [key, ...rest] = item.replace(/^--/, "").split("="); return [key, rest.join("=") || true]; }));
if (!args.audit || !args.url) throw new Error("Uso: node scripts/crawl-site-audit.mjs --audit=<id> --url=<https://dominio> [--max=500] [--deep=50]");
const maxPages = Math.max(1, Math.min(500, Number(args.max) || 500));
const maxDeep = Math.max(0, Math.min(50, Number(args.deep) || 50));
const timeoutMs = Math.max(3000, Math.min(30000, Number(args.timeout) || 12000));
const auditStore = new AuditStore(), detailStore = new AuditDetailStore(), projectSettings = new ProjectSettingsStore();
const current = await auditStore.get(String(args.audit));
if (current.manifest.status === "completed") throw new Error("El snapshot está completado; crea una auditoría nueva.");
const config = await projectSettings.resolved(current.manifest.project.slug);
const allowPrivateHosts = args["allow-private"] === true || process.env.SEO_ALLOW_PRIVATE_HOSTS === "1" || config.allowPrivateHosts === true;
const base = new URL(String(args.url)); base.hash = ""; base.search = "";
const exclusions = config.crawlExclusions || [];
const isExcluded = (url) => {
  try {
    const pathname = new URL(url).pathname;
    return exclusions.some((rule) => { const normalized = String(rule).trim(); if (!normalized) return false; const prefix = normalized.endsWith("*") ? normalized.slice(0, -1) : normalized; return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`); });
  } catch { return false; }
};

function assertFetchTarget(url) {
  assertWebTarget(url, { allowPrivateHosts });
}
assertFetchTarget(base.toString());

const decodeXml = (text) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
const strip = (text) => String(text || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
const firstContent = (html, regex) => strip(html.match(regex)?.[1] || "");
const sameSite = (url) => { try { return new URL(url).origin === base.origin; } catch { return false; } };
const absolute = (value, from = base) => { try { const url = new URL(value, from); url.hash = ""; return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; } };
const fetchText = async (url, accept = "text/html,application/xml,text/plain;q=0.9") => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response, currentUrl = url;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      assertFetchTarget(currentUrl);
      response = await fetch(currentUrl, { redirect: "manual", signal: controller.signal, headers: { accept, "user-agent": "SEO-Workspace-Audit/4.0 (+local read-only audit)" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
    }
    const contentType = response.headers.get("content-type") || "";
    const text = /text|json|xml|html|javascript/i.test(contentType) ? (await response.text()).slice(0, 5_000_000) : "";
    return { ok: true, response, text, contentType };
  } catch (error) { return { ok: false, error, response: null, text: "", contentType: "" }; }
  finally { clearTimeout(timer); }
};

const diagnostics = [], sitemapInventory = [], sitemapMembership = new Map(), sitemapSeen = new Set(), discovered = new Map();
const diagnostic = (code, stage, source, scope, message, retryable, completenessImpact, nextAction) => diagnostics.push({ code, stage, source, scope, message, retryable, completenessImpact, nextAction });
function remember(url, source, sitemap = null, lastmod = null, depth = 0) {
  const resolved = absolute(url);
  if (!resolved || !sameSite(resolved) || isExcluded(resolved)) return;
  let normalized; try { normalized = normalizePageUrl(resolved); } catch { return; }
  const previous = discovered.get(normalized) || { url: normalized, sources: new Set(), sitemaps: new Set(), lastmod: null, depth };
  previous.sources.add(source); if (sitemap) previous.sitemaps.add(sitemap); if (lastmod) previous.lastmod = lastmod; previous.depth = Math.min(previous.depth, depth);
  discovered.set(normalized, previous);
}
async function crawlSitemap(url, parent = null, depth = 0) {
  const resolved = absolute(url); if (!resolved || sitemapSeen.has(resolved) || sitemapSeen.size >= 100 || depth > 5) return;
  sitemapSeen.add(resolved);
  const result = await fetchText(resolved, "application/xml,text/xml;q=0.9,*/*;q=0.1");
  if (!result.ok || !result.response.ok) {
    sitemapInventory.push({ url: resolved, parent, status: result.response?.status || null, type: "unknown", urls: 0 });
    diagnostic("sitemap-fetch-failed", "discovery", "crawler", resolved, result.error?.message || `HTTP ${result.response?.status}`, true, "Puede faltar una parte del inventario de URLs.", "Corregir o reintentar la lectura del sitemap."); return;
  }
  const text = result.text;
  if (!/<(?:urlset|sitemapindex)\b/i.test(text)) {
    sitemapInventory.push({ url: resolved, parent, status: result.response.status, type: "malformed", urls: 0 });
    diagnostic("sitemap-malformed", "discovery", "crawler", resolved, "El XML no contiene urlset ni sitemapindex.", false, "Las URLs de este recurso no pudieron descubrirse.", "Validar el XML y su Content-Type."); return;
  }
  const type = /<sitemapindex\b/i.test(text) ? "index" : "urlset";
  const entries = [...text.matchAll(/<(sitemap|url)>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?(?:<lastmod>([\s\S]*?)<\/lastmod>)?[\s\S]*?<\/\1>/gi)].map((match) => ({ loc: decodeXml(strip(match[2])), lastmod: strip(match[3]) || null }));
  sitemapInventory.push({ url: resolved, parent, status: result.response.status, type, urls: type === "urlset" ? entries.length : 0, children: type === "index" ? entries.length : 0 });
  if (type === "index") for (const entry of entries) await crawlSitemap(entry.loc, resolved, depth + 1);
  else for (const entry of entries) { remember(entry.loc, "sitemap", resolved, entry.lastmod); const list = sitemapMembership.get(entry.loc) || []; list.push(resolved); sitemapMembership.set(entry.loc, list); }
}

const robotsUrl = new URL("/robots.txt", base).toString(), robotsResult = await fetchText(robotsUrl, "text/plain");
const robotsText = robotsResult.ok ? robotsResult.text : "";
const robotsRules = robotsText.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()).filter(Boolean).map((line) => { const split = line.indexOf(":"); return split > 0 ? { directive: line.slice(0, split).trim().toLowerCase(), value: line.slice(split + 1).trim() } : null; }).filter(Boolean);
const sitemapCandidates = [...new Set([...(robotsRules.filter((item) => item.directive === "sitemap").map((item) => item.value)), new URL("/sitemap.xml", base).toString()])];
for (const sitemap of sitemapCandidates) await crawlSitemap(sitemap);
remember(base.toString(), "seed", null, null, 0);

const gscDataset = current.metrics.datasets.find((item) => item.id === "gsc-page-opportunities");
const gscRows = (gscDataset?.rows || []).map((row) => { try { return { url: normalizePageUrl(row.label), values: row.values }; } catch { return { url: row.label, values: row.values }; } });
for (const row of gscRows) remember(row.url, "search-console");
const queue = [...discovered.values()].slice(0, maxPages), pages = [];
const expectedLocaleFor = (url) => {
  const pathname = new URL(url).pathname;
  const configured = Object.entries(config.localeMap || {}).sort(([a], [b]) => b.length - a.length).find(([prefix]) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  if (configured) return configured[1];
  const segment = pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  return ["es", "ca", "en"].includes(segment) ? segment : null;
};
const gscForPage = (url, finalUrl, canonicalUrl) => {
  const candidates = [url, finalUrl, canonicalUrl].filter(Boolean).map((value) => { try { return normalizePageUrl(value); } catch { return value; } });
  for (const [index, candidate] of candidates.entries()) { const match = gscRows.find((row) => row.url === candidate); if (match) return { ...match.values, attribution: index === 0 ? "exact" : index === 1 ? "redirect" : "canonical", matchedUrl: match.url }; }
  return {};
};
async function analyze(entry) {
  const result = await fetchText(entry.url), fetchedAt = new Date().toISOString();
  if (!result.ok) {
    const pageDiagnostic = { code: result.error?.code === "private-host-blocked" ? "private-host-blocked" : "page-fetch-failed", stage: "crawl", source: "crawler", scope: entry.url, message: result.error?.message || "No se pudo cargar.", retryable: true, completenessImpact: "La URL queda sin cobertura técnica.", nextAction: "Reintentar el rastreo y revisar DNS, TLS, protocolo web o timeout.", attemptedAt: fetchedAt };
    diagnostic(pageDiagnostic.code, pageDiagnostic.stage, pageDiagnostic.source, pageDiagnostic.scope, pageDiagnostic.message, pageDiagnostic.retryable, pageDiagnostic.completenessImpact, pageDiagnostic.nextAction);
    return { url: entry.url, discoverySources: [...entry.sources], sitemapUrls: [...entry.sitemaps], depth: entry.depth, auditLevel: "light", coverage: "none", expectedLocale: expectedLocaleFor(entry.url), declaredLocale: null, healthReason: "No hay evidencia suficiente para clasificar la página.", evidence: { http: false, dom: false, screenshots: false, lighthouse: false, searchConsole: false, analytics: false }, response: { status: null, error: result.error?.name || "fetch-error" }, indexability: { indexable: null, reason: "Sin respuesta" }, metadata: {}, links: {}, images: {}, schemas: {}, diagnostics: [pageDiagnostic] };
  }
  const { response, text: html, contentType } = result, htmlPage = /html/i.test(contentType);
  const title = firstContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i), descriptionTag = html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i)?.[0] || html.match(/<meta\b[^>]*content=["'][^"']*["'][^>]*name=["']description["'][^>]*>/i)?.[0] || "";
  const description = attr(descriptionTag, "content"), robotsMetaTag = html.match(/<meta\b[^>]*name=["']robots["'][^>]*>/i)?.[0] || "", robotsMeta = attr(robotsMetaTag, "content").toLowerCase();
  const canonicalTag = html.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i)?.[0] || "", canonicalUrl = absolute(attr(canonicalTag, "href"), response.url);
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || "", locale = attr(htmlTag, "lang");
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => strip(match[1])).filter(Boolean);
  const allLinks = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((match) => absolute(match[1], response.url)).filter(Boolean);
  const internalLinks = [...new Set(allLinks.filter(sameSite))], externalLinks = [...new Set(allLinks.filter((url) => !sameSite(url)))];
  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]), missingAlt = imageTags.filter((tag) => !/\balt\s*=/i.test(tag)).length;
  const hreflangs = [...html.matchAll(/<link\b[^>]*rel=["'][^"']*alternate[^"']*["'][^>]*>/gi)].map((match) => ({ locale: attr(match[0], "hreflang"), url: absolute(attr(match[0], "href"), response.url) })).filter((item) => item.locale && item.url);
  const schemaTypes = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { const value = JSON.parse(match[1]); const collect = (node) => { if (Array.isArray(node)) node.forEach(collect); else if (node && typeof node === "object") { const type = node["@type"]; if (Array.isArray(type)) schemaTypes.push(...type); else if (type) schemaTypes.push(String(type)); if (node["@graph"]) collect(node["@graph"]); } }; collect(value); } catch {} }
  const text = strip(html), soft404 = response.status === 200 && /(?:404|página no encontrada|page not found)/i.test(`${title} ${text.slice(0, 500)}`);
  for (const url of internalLinks) if (discovered.size < maxPages) remember(url, "internal-link", null, null, entry.depth + 1);
  const canonical = canonicalUrl ? normalizePageUrl(canonicalUrl) : null, noindex = /(?:^|,)\s*noindex\b/.test(robotsMeta), indexable = response.ok && !noindex && !soft404 && htmlPage, expectedLocale = expectedLocaleFor(entry.url), searchConsole = gscForPage(entry.url, response.url, canonical);
  return { url: entry.url, canonicalUrl: canonical, discoverySources: [...entry.sources], sitemapUrls: [...entry.sitemaps], template: new URL(entry.url).pathname === "/" ? "home" : new URL(entry.url).pathname.split("/").filter(Boolean).length <= 1 ? "landing" : "detail", locale: expectedLocale || locale || null, expectedLocale, declaredLocale: locale || null, depth: entry.depth, auditLevel: "light", coverage: htmlPage ? "complete" : "partial", healthReason: "Cobertura HTTP y HTML disponible; se completarán las señales profundas si la URL es seleccionada.", evidence: { http: true, dom: false, screenshots: false, lighthouse: false, searchConsole: Object.keys(searchConsole).length > 0, analytics: false }, fetchedAt, response: { status: response.status, finalUrl: response.url, redirected: response.redirected, contentType, soft404 }, indexability: { indexable, reason: !response.ok ? `HTTP ${response.status}` : noindex ? "meta robots noindex" : soft404 ? "soft 404 probable" : !htmlPage ? "No es HTML" : "Rastreable e indexable", robotsMeta, canonical: canonical || "" }, metadata: { title, titleLength: title.length, description, descriptionLength: description.length, h1Count: h1.length, h1: h1[0] || "", headings: h1.slice(0, 10), wordCount: text ? text.split(/\s+/).length : 0, hreflangCount: hreflangs.length, hreflang: hreflangs.slice(0, 30) }, links: { internalCount: internalLinks.length, externalCount: externalLinks.length, internal: internalLinks.slice(0, 100), external: externalLinks.slice(0, 50) }, images: { count: imageTags.length, missingAlt }, schemas: { count: schemaTypes.length, types: [...new Set(schemaTypes)].slice(0, 30) }, searchConsole };
}

let cursor = 0;
while (cursor < queue.length && pages.length < maxPages) {
  const batch = queue.slice(cursor, cursor + 6); cursor += batch.length;
  pages.push(...await Promise.all(batch.map(analyze)));
  for (const entry of [...discovered.values()]) if (queue.length < maxPages && !queue.some((item) => item.url === entry.url)) queue.push(entry);
}
for (const page of pages) {
  page.links.incoming = pages.filter((candidate) => candidate.links?.internal?.includes(page.url)).map((candidate) => candidate.url).slice(0, 100);
  page.links.incomingCount = page.links.incoming.length;
}

const definitions = {
  "http-error": { severity: "p1", title: "La página no responde correctamente", explanation: "El servidor devuelve un error o no permite obtener el documento.", impact: "Los buscadores y usuarios no pueden acceder al contenido.", action: ["Restaurar una respuesta HTTP 200 válida.", "Revisar logs y enlaces que apuntan a la URL."], validation: "La URL responde 200 en un nuevo rastreo." },
  "soft-404": { severity: "p1", title: "La página parece un soft 404", explanation: "Devuelve 200 pero su contenido comunica que no existe.", impact: "Desperdicia rastreo y puede confundir la indexación.", action: ["Devolver 404/410 si fue eliminada o publicar contenido real.", "Retirar la URL del sitemap si no debe indexarse."], validation: "La respuesta y el contenido representan el mismo estado." },
  "noindex-sitemap": { severity: "p1", title: "URL del sitemap marcada noindex", explanation: "El sitemap propone indexar una URL que se excluye mediante robots meta.", impact: "Envía señales contradictorias y dificulta el diagnóstico de cobertura.", action: ["Decidir si la URL debe indexarse.", "Quitar noindex o retirar la URL de todos los sitemaps."], validation: "Sitemap e indexabilidad ya no se contradicen." },
  "missing-title": { severity: "p2", title: "Falta el título HTML", explanation: "La página no declara un título descriptivo.", impact: "Reduce claridad temática y control del snippet.", action: ["Añadir un title único y descriptivo.", "Incluir la intención principal sin repetir plantillas."], validation: "Existe un title único y pertinente." },
  "missing-description": { severity: "p3", title: "Falta la meta description", explanation: "La página no propone un resumen para los resultados de búsqueda.", impact: "Google decidirá el fragmento sin una propuesta editorial propia.", action: ["Redactar una descripción específica y útil.", "Evitar duplicados entre URLs."], validation: "Existe una descripción única y coherente con la página." },
  "missing-h1": { severity: "p2", title: "Falta un encabezado H1", explanation: "No hay un encabezado principal detectable.", impact: "Debilita la jerarquía del contenido y su lectura.", action: ["Añadir un H1 visible que describa la página.", "Mantener una jerarquía H2/H3 coherente."], validation: "El documento tiene un H1 visible y descriptivo." },
  "multiple-h1": { severity: "p3", title: "Hay varios encabezados H1", explanation: "La plantilla presenta más de un encabezado principal.", impact: "La jerarquía puede resultar ambigua para usuarios y herramientas.", action: ["Conservar un único H1 editorial.", "Convertir los demás en H2 o elementos no semánticos."], validation: "Solo existe un H1 principal." },
  "missing-canonical": { severity: "p2", title: "Falta canonical", explanation: "La página no declara su URL canónica.", impact: "Aumenta la ambigüedad ante parámetros o duplicados.", action: ["Añadir un canonical absoluto autorreferente.", "Comprobar que apunta a una URL 200 e indexable."], validation: "El canonical existe, es absoluto y responde 200." },
  "canonical-mismatch": { severity: "p2", title: "El canonical apunta a otra URL", explanation: "La URL rastreada consolida señales en un destino distinto.", impact: "Puede impedir que esta variante sea la elegida para indexar.", action: ["Confirmar que la consolidación es intencionada.", "Si no lo es, corregir canonical, enlaces internos y sitemap."], validation: "Canonical, enlaces y sitemap señalan la URL deseada." },
  "images-missing-alt": { severity: "p3", title: "Imágenes sin atributo alt", explanation: "Hay imágenes sin alternativa textual declarada.", impact: "Reduce accesibilidad y contexto semántico de las imágenes.", action: ["Añadir alt descriptivo a imágenes informativas.", "Usar alt vacío en imágenes puramente decorativas."], validation: "Todas las imágenes tienen un alt adecuado a su función." },
  "locale-mismatch": { severity: "p2", title: "El idioma declarado no coincide", explanation: "La ruta o configuración del proyecto espera un idioma distinto al declarado por la página.", impact: "Puede confundir la indexación internacional y la experiencia de usuarios de otros idiomas.", action: ["Alinear html lang, ruta y contenido con el idioma esperado.", "Revisar hreflang y el mapa de idiomas del proyecto."], validation: "El idioma declarado coincide con la URL y sus alternates hreflang." },
};
const findings = [];
function add(rule, page, evidence) { const item = definitions[rule]; findings.push({ ruleId: rule, scope: "page", severity: item.severity, category: "technical", title: item.title, explanation: item.explanation, evidence, impact: item.impact, affectedUrls: [page.url], source: "crawler", confidence: rule === "soft-404" ? "medium" : "high", actions: [{ title: `Corregir: ${item.title}`, why: item.impact, steps: item.action, validation: item.validation, ownerRole: rule.includes("description") || rule.includes("title") || rule.includes("h1") ? "SEO y contenido" : "Desarrollo web", effort: ["http-error", "soft-404"].includes(rule) ? "m" : "s" }] }); }
for (const page of pages) {
  if (!page.response?.status || page.response.status >= 400) add("http-error", page, page.response?.status ? `Respuesta HTTP ${page.response.status}.` : "La petición falló sin respuesta HTTP.");
  if (page.response?.soft404) add("soft-404", page, "La respuesta es 200 y el título o contenido contiene una señal de página no encontrada.");
  const noindex = page.indexability?.robotsMeta?.includes("noindex");
  const noindexContradiction = noindex && (page.sitemapUrls.length > 0 || (page.links?.incomingCount || 0) > 0 || Number(page.searchConsole?.clicks || 0) > 0 || Number(page.searchConsole?.impressions || 0) > 0 || (page.canonicalUrl && page.canonicalUrl !== normalizePageUrl(page.url)));
  if (noindexContradiction) add("noindex-sitemap", page, `noindex contradice señales de descubrimiento o rendimiento${page.sitemapUrls.length ? `; sitemap: ${page.sitemapUrls.join(", ")}` : ""}.`);
  if (page.response?.contentType?.includes("html")) {
    if (!page.metadata.title) add("missing-title", page, "No se encontró <title> en el HTML recibido.");
    if (!page.metadata.description) add("missing-description", page, "No se encontró meta description.");
    if (!page.metadata.h1Count) add("missing-h1", page, "No se encontró ningún H1 con texto.");
    if (page.metadata.h1Count > 1) add("multiple-h1", page, `Se detectaron ${page.metadata.h1Count} encabezados H1.`);
    if (!page.canonicalUrl) add("missing-canonical", page, "No se encontró link rel=canonical válido.");
    else if (page.canonicalUrl !== normalizePageUrl(page.url)) add("canonical-mismatch", page, `Canonical declarado: ${page.canonicalUrl}.`);
    if (page.images.missingAlt > 0) add("images-missing-alt", page, `${page.images.missingAlt} de ${page.images.count} imágenes no declaran alt.`);
    if (page.expectedLocale && page.declaredLocale && page.expectedLocale.toLowerCase() !== page.declaredLocale.toLowerCase()) add("locale-mismatch", page, `Se esperaba ${page.expectedLocale} y se declaró ${page.declaredLocale}.`);
  }
}
const savedFindings = await detailStore.saveFindings(current.manifest.id, findings);
const idsByUrl = new Map();
for (const finding of savedFindings.findings) for (const url of finding.affectedUrls) { const list = idsByUrl.get(url) || []; list.push(finding); idsByUrl.set(url, list); }
const ranked = [...pages].sort((a, b) => { const af = idsByUrl.get(normalizePageUrl(a.url)) || [], bf = idsByUrl.get(normalizePageUrl(b.url)) || []; const aw = af.reduce((sum, item) => sum + ({ p0: 100, p1: 30, p2: 10, p3: 2 }[item.severity] || 0), 0) + Number(a.searchConsole?.impressions || 0) / 1000; const bw = bf.reduce((sum, item) => sum + ({ p0: 100, p1: 30, p2: 10, p3: 2 }[item.severity] || 0), 0) + Number(b.searchConsole?.impressions || 0) / 1000; return bw - aw || a.url.localeCompare(b.url); });
const deep = new Set(ranked.slice(0, maxDeep).map((page) => page.url));
for (const page of pages) {
  const related = idsByUrl.get(normalizePageUrl(page.url)) || [], counts = { p0: 0, p1: 0, p2: 0, p3: 0, info: 0 };
  for (const finding of related) counts[finding.severity]++;
  page.findingIds = related.map((item) => item.id); page.issueCounts = counts;
  page.healthReason = counts.p0 ? "Hay al menos una incidencia P0 verificada." : counts.p1 || counts.p2 || counts.p3 ? `Hay ${counts.p1 + counts.p2 + counts.p3} incidencias P1-P3 verificadas.` : page.coverage === "none" ? "No hay evidencia suficiente para clasificar la página." : "No se han verificado incidencias en la cobertura disponible.";
  if (deep.has(page.url)) { page.auditLevel = "deep"; page.coverage = "partial"; page.evidence = { ...(page.evidence || {}), dom: false, screenshots: false, lighthouse: false }; page.diagnostics = [...(page.diagnostics || []).filter((item) => item.code !== "deep-browser-evidence-pending"), { code: "deep-browser-evidence-pending", stage: "deep-audit", source: "browser", scope: page.url, message: "La URL está seleccionada para análisis profundo; el rastreador HTTP no sustituye la fase de navegador.", retryable: true, completenessImpact: "La evidencia HTTP y HTML está disponible, pero faltan DOM renderizado, rendimiento o evidencia visual hasta que la orquestadora los guarde.", nextAction: "Completar la fase de navegador de /seo full y actualizar esta página con sus métricas y assets.", attemptedAt: new Date().toISOString() }]; }
}
for (let index = 0; index < pages.length; index += 25) await detailStore.savePageBatch(current.manifest.id, pages.slice(index, index + 25));
const resourceCandidates = ["/manifest.webmanifest", "/site.webmanifest", "/manifest.json", "/feed.xml", "/rss.xml", "/llms.txt", "/.well-known/security.txt"];
const resources = [];
for (const path of resourceCandidates) { const url = new URL(path, base).toString(), result = await fetchText(url, "*/*"); resources.push({ url, status: result.response?.status || null, contentType: result.contentType || "", present: Boolean(result.response?.ok) }); }
const schemaCounts = new Map(); for (const page of pages) for (const type of page.schemas?.types || []) schemaCounts.set(type, (schemaCounts.get(type) || 0) + 1);
if (deep.size) diagnostic("deep-browser-evidence-pending", "deep-audit", "browser", `${deep.size} páginas`, "El rastreador seleccionó las páginas profundas; DOM renderizado, capturas, Lighthouse y fuentes Google se completan en la fase de navegador de /seo full.", true, "La cobertura profunda permanece parcial mientras falten las fuentes indicadas.", "Completar la fase de navegador y guardar assets y métricas únicamente cuando estén disponibles.");
const completeSitemaps = sitemapInventory.map((sitemap) => ({ ...sitemap, urls: sitemap.type === "urlset" ? pages.filter((page) => page.sitemapUrls.includes(sitemap.url)).map((page) => ({ loc: page.url, lastmod: discovered.get(page.url)?.lastmod || null, status: page.response?.status || null, indexable: page.indexability?.indexable ?? null, canonical: page.canonicalUrl || null })) : [] }));
await detailStore.saveInventory(current.manifest.id, { sitemaps: completeSitemaps, robots: { url: robotsUrl, status: robotsResult.response?.status || null, rules: robotsRules, textPreview: robotsText.slice(0, 5000) }, manifest: resources.find((item) => item.present && item.url.includes("manifest")) || null, feeds: resources.filter((item) => item.present && /feed|rss/.test(item.url)), agentFiles: resources.filter((item) => item.present && /llms|security/.test(item.url)), schema: [...schemaCounts].map(([type, pages]) => ({ type, pages })), criticalResources: resources }, diagnostics);
const criticalCount = savedFindings.findings.filter((item) => ["p0", "p1"].includes(item.severity)).length;
const priorityCandidates = savedFindings.findings.slice().sort((a, b) => ["p0", "p1", "p2", "p3", "info"].indexOf(a.severity) - ["p0", "p1", "p2", "p3", "info"].indexOf(b.severity));
const priorities = [...new Map(priorityCandidates.map((item) => [item.ruleId, item])).values()].slice(0, 5).map((item) => ({ title: item.title, why: item.impact, validation: item.actions[0]?.validation || "Repetir la auditoría.", findingId: item.id }));
const sourceCoverage = current.manifest.sourceCoverage.map((source) => source.id === "crawl" ? { ...source, status: "available", detail: `${pages.length} URLs rastreadas desde sitemap, enlaces internos y Search Console`, updatedAt: new Date().toISOString() } : source);
await auditStore.save({ id: current.manifest.id, title: current.manifest.title, project: current.manifest.project, status: "draft", sourceCoverage, executive: { state: `${pages.length} URLs rastreadas; ${criticalCount} incidencias críticas o altas y ${diagnostics.length} limitaciones de recopilación.`, change: "Este snapshot se actualizó a v4 con evidencia por URL; los datos que no estaban disponibles permanecen explícitamente sin cobertura.", priorities } });
const changes = await getAuditChanges(current.manifest.id);
await writeAuditJsonAtomic(current.manifest.id, "changes.json", { version: 4, updatedAt: new Date().toISOString(), ...changes });
await detailStore.updateContent(current.manifest.id, { changes: { path: "changes.json", count: changes.pageChanges.length } });
console.log(JSON.stringify({ auditId: current.manifest.id, version: 4, pages: pages.length, deepSelected: deep.size, findings: savedFindings.findings.length, diagnostics: diagnostics.length, sitemaps: sitemapInventory.length }, null, 2));
