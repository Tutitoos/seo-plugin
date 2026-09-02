import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAnalyticsClient } from "../mcp/lib/google-analytics-api.mjs";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

test("renueva una vez tras 401", async () => {
  const tokens = [];
  let requests = 0;
  const client = new GoogleAnalyticsClient({
    oauth: { async getAccessToken(options) { tokens.push(options || {}); return options?.forceRefresh ? "fresh" : "stale"; } },
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) { assert.equal(options.headers.Authorization, "Bearer stale"); return jsonResponse({ error: { message: "expired" } }, 401); }
      assert.equal(options.headers.Authorization, "Bearer fresh");
      return jsonResponse({ accountSummaries: [] });
    },
  });
  assert.deepEqual(await client.listAccountSummaries(), { accountSummaries: [], nextPageToken: null });
  assert.deepEqual(tokens, [{}, { forceRefresh: true }]);
});

test("pagina accountSummaries", async () => {
  const urls = [];
  const client = new GoogleAnalyticsClient({
    oauth: { async getAccessToken() { return "token"; } },
    fetchImpl: async (url) => {
      urls.push(url);
      return urls.length === 1 ? jsonResponse({ accountSummaries: [{ account: "accounts/1" }], nextPageToken: "next" }) : jsonResponse({ accountSummaries: [{ account: "accounts/2" }] });
    },
  });
  const result = await client.listAccountSummaries();
  assert.deepEqual(result.accountSummaries.map((item) => item.account), ["accounts/1", "accounts/2"]);
  assert.equal(new URL(urls[1]).searchParams.get("pageToken"), "next");
});

test("serializa un informe y no filtra el bearer", async () => {
  let captured;
  const client = new GoogleAnalyticsClient({
    oauth: { async getAccessToken() { return "super-secret-token"; } },
    fetchImpl: async (url, options) => { captured = { url, options }; return jsonResponse({ rows: [] }); },
  });
  await client.runReport("properties/123", { metrics: [{ name: "sessions" }] });
  assert.match(captured.url, /properties\/123:runReport$/);
  assert.deepEqual(JSON.parse(captured.options.body), { metrics: [{ name: "sessions" }] });
  const denied = new GoogleAnalyticsClient({
    oauth: { async getAccessToken() { return "super-secret-token"; } },
    fetchImpl: async () => jsonResponse({ error: { message: "insufficient permissions" } }, 403),
  });
  await assert.rejects(denied.getMetadata("properties/123"), (error) => /denegó el acceso/.test(error.message) && !error.message.includes("super-secret-token"));
});

test("reintenta 429 como máximo dos veces", async () => {
  let requests = 0;
  const delays = [];
  const client = new GoogleAnalyticsClient({
    oauth: { async getAccessToken() { return "token"; } },
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => { requests += 1; return requests < 3 ? jsonResponse({ error: { message: "quota" } }, 429, { "Retry-After": "1" }) : jsonResponse({ rows: [] }); },
  });
  assert.deepEqual(await client.runRealtimeReport("properties/123", {}), { rows: [] });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1000, 1000]);
});
