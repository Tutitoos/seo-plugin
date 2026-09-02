import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);

test("rastrea sitemaps anidados o cíclicos y conserva errores sin inventar cobertura", async (t) => {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/robots.txt") { response.setHeader("content-type", "text/plain"); return response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap-index.xml`); }
    if (request.url?.endsWith(".xml")) response.setHeader("content-type", "application/xml"); else response.setHeader("content-type", "text/html");
    if (request.url === "/sitemap-index.xml") return response.end(`<sitemapindex><sitemap><loc>${origin}/sitemap-index.xml</loc></sitemap><sitemap><loc>${origin}/pages.xml</loc></sitemap><sitemap><loc>${origin}/bad.xml</loc></sitemap></sitemapindex>`);
    if (request.url === "/pages.xml") return response.end(`<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/broken</loc></url><url><loc>${origin}/soft</loc></url></urlset>`);
    if (request.url === "/bad.xml") return response.end("esto no es XML de sitemap");
    if (request.url === "/broken") { response.statusCode = 500; return response.end("error"); }
    if (request.url === "/soft") return response.end("<html><title>Página no encontrada</title><h1>404</h1></html>");
    if (["/manifest.webmanifest", "/site.webmanifest", "/manifest.json", "/feed.xml", "/rss.xml", "/llms.txt", "/.well-known/security.txt", "/sitemap.xml"].includes(request.url)) { response.statusCode = 404; return response.end("no"); }
    response.setHeader("content-type", "text/html"); response.end(`<html lang="es"><head><title>Inicio</title><meta name="description" content="Demo"><link rel="canonical" href="${origin}/"></head><body><h1>Inicio</h1><a href="/broken">Rota</a></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), "seo-crawler-"));
  process.env.SEO_PLUGIN_DATA_DIR = root;
  const { AuditStore } = await import(`../src/audit-store.mjs?crawler=${Date.now()}`);
  await new AuditStore().save({ id: "crawl-audit", title: "Crawl", project: { slug: "demo", name: "Demo" }, status: "draft" });
  const url = `http://127.0.0.1:${server.address().port}`;
  const { stdout } = await run(process.execPath, ["scripts/crawl-site-audit.mjs", "--audit=crawl-audit", `--url=${url}`, "--max=20", "--deep=2", "--allow-private"], { cwd: new URL("..", import.meta.url), env: { ...process.env, SEO_PLUGIN_DATA_DIR: root }, timeout: 20000 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.version, 5);
  assert.ok(summary.pages >= 3);
  const diagnostics = JSON.parse(await readFile(join(root, "audits", "crawl-audit", "diagnostics.json")));
  assert.ok(diagnostics.diagnostics.some((item) => item.code === "sitemap-malformed"));
  const findings = JSON.parse(await readFile(join(root, "audits", "crawl-audit", "findings.json")));
  assert.ok(findings.findings.some((item) => item.ruleId === "http-error"));
  assert.ok(findings.findings.some((item) => item.ruleId === "soft-404"));
  const pages = JSON.parse(await readFile(join(root, "audits", "crawl-audit", "pages", "index.json")));
  const png = join(root, "capture.png"); await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await run(process.execPath, ["scripts/attach-page-evidence.mjs", "--audit=crawl-audit", `--page=${pages.pages[0].id}`, `--desktop=${png}`], { cwd: new URL("..", import.meta.url), env: { ...process.env, SEO_PLUGIN_DATA_DIR: root }, timeout: 10000 });
  const attached = JSON.parse(await readFile(join(root, "audits", "crawl-audit", "pages", pages.pages[0].id, "page.json")));
  assert.equal(attached.screenshots[0].path, "desktop.png");
});
