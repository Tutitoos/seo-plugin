import assert from "node:assert/strict";
import test from "node:test";
import { GoogleSearchConsoleClient } from "../mcp/lib/google-api.mjs";

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
  const client = new GoogleSearchConsoleClient({
    oauth,
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) {
        assert.equal(options.headers.Authorization, "Bearer stale");
        return jsonResponse({ error: { message: "expired" } }, 401);
      }
      assert.equal(options.headers.Authorization, "Bearer fresh");
      return jsonResponse({ siteEntry: [] });
    },
  });
  assert.deepEqual(await client.listSites(), { siteEntry: [] });
  assert.deepEqual(tokens, [{}, { forceRefresh: true }]);
});

test("reintenta 429 como máximo dos veces respetando Retry-After", async () => {
  let requests = 0;
  const delays = [];
  const client = new GoogleSearchConsoleClient({
    oauth: { async getAccessToken() { return "token"; } },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      requests += 1;
      if (requests < 3) return jsonResponse({ error: { message: "quota" } }, 429, { "Retry-After": "1" });
      return jsonResponse({ rows: [] });
    },
  });
  assert.deepEqual(await client.queryPerformance("sc-domain:example.com", {}), { rows: [] });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("codifica la propiedad y serializa el cuerpo de rendimiento", async () => {
  let captured;
  const client = new GoogleSearchConsoleClient({
    oauth: { async getAccessToken() { return "token"; } },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ rows: [] });
    },
  });
  await client.queryPerformance("https://www.example.com/", { startDate: "2026-08-01", endDate: "2026-08-28" });
  assert.match(captured.url, /https%3A%2F%2Fwww\.example\.com%2F/);
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), { startDate: "2026-08-01", endDate: "2026-08-28" });
});

test("traduce un 403 sin filtrar el bearer token", async () => {
  const client = new GoogleSearchConsoleClient({
    oauth: { async getAccessToken() { return "super-secret-token"; } },
    fetchImpl: async () => jsonResponse({ error: { message: "insufficient permissions" } }, 403),
  });
  await assert.rejects(
    client.listSites(),
    (error) => /denegó el acceso/.test(error.message) && !error.message.includes("super-secret-token"),
  );
});
