import assert from "node:assert/strict";
import test from "node:test";
import { GoogleBusinessProfileClient } from "../mcp/lib/google-business-api.mjs";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("renueva una vez tras 401 y conserva la petición", async () => {
  const tokens = [];
  const oauth = {
    async getAccessToken(options) {
      tokens.push(options || {});
      return options?.forceRefresh ? "fresh" : "stale";
    },
  };
  let requests = 0;
  const client = new GoogleBusinessProfileClient({
    oauth,
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) {
        assert.equal(options.headers.Authorization, "Bearer stale");
        return jsonResponse({ error: { message: "expired" } }, 401);
      }
      assert.equal(options.headers.Authorization, "Bearer fresh");
      return jsonResponse({ accounts: [] });
    },
  });
  assert.deepEqual(await client.listAccounts(), { accounts: [] });
  assert.deepEqual(tokens, [{}, { forceRefresh: true }]);
});

test("reintenta 429 como máximo dos veces respetando Retry-After", async () => {
  let requests = 0;
  const delays = [];
  const client = new GoogleBusinessProfileClient({
    oauth: { async getAccessToken() { return "token"; } },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      requests += 1;
      if (requests < 3) return jsonResponse({ error: { message: "quota" } }, 429, { "Retry-After": "1" });
      return jsonResponse({ locations: [] });
    },
  });
  await client.listLocations({ accountName: "accounts/-", readMask: "name,title" });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("serializa ubicación, máscara y paginación sin duplicar la cuenta", async () => {
  let captured;
  const client = new GoogleBusinessProfileClient({
    oauth: { async getAccessToken() { return "token"; } },
    fetchImpl: async (url) => {
      captured = new URL(url);
      return jsonResponse({ locations: [] });
    },
  });
  await client.listLocations({
    accountName: "accounts/123",
    readMask: "name,title,metadata",
    pageSize: 25,
    pageToken: "next",
  });
  assert.equal(captured.pathname, "/v1/accounts/123/locations");
  assert.equal(captured.searchParams.get("readMask"), "name,title,metadata");
  assert.equal(captured.searchParams.get("pageToken"), "next");
});

test("construye la ruta v4 de reseñas", async () => {
  let captured;
  const client = new GoogleBusinessProfileClient({
    oauth: { async getAccessToken() { return "token"; } },
    fetchImpl: async (url) => {
      captured = new URL(url);
      return jsonResponse({ reviews: [] });
    },
  });
  await client.listReviews({ accountName: "accounts/123", locationName: "locations/456" });
  assert.equal(captured.pathname, "/v4/accounts/123/locations/456/reviews");
  assert.equal(captured.searchParams.get("pageSize"), "50");
});

test("construye el intervalo y métricas de Performance API", async () => {
  let captured;
  const client = new GoogleBusinessProfileClient({
    oauth: { async getAccessToken() { return "token"; } },
    fetchImpl: async (url) => {
      captured = new URL(url);
      return jsonResponse({ multiDailyMetricTimeSeries: [] });
    },
  });
  await client.fetchPerformance({
    locationName: "locations/456",
    dailyMetrics: ["WEBSITE_CLICKS", "CALL_CLICKS"],
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
  assert.equal(captured.pathname, "/v1/locations/456:fetchMultiDailyMetricsTimeSeries");
  assert.deepEqual(captured.searchParams.getAll("dailyMetrics"), ["WEBSITE_CLICKS", "CALL_CLICKS"]);
  assert.equal(captured.searchParams.get("dailyRange.end_date.day"), "31");
});

test("traduce 403 sin filtrar el bearer token", async () => {
  const client = new GoogleBusinessProfileClient({
    oauth: { async getAccessToken() { return "super-secret-token"; } },
    fetchImpl: async () => jsonResponse({ error: { message: "PERMISSION_DENIED" } }, 403),
  });
  await assert.rejects(
    client.listAccounts(),
    (error) => /aprobadas y habilitadas/.test(error.message) && !error.message.includes("super-secret-token"),
  );
});
