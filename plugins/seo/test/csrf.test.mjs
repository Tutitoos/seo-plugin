import test from "node:test";
import assert from "node:assert/strict";
import { issueCsrfToken, validateLocalMutation } from "../src/csrf.mjs";

function jar() {
  const values = new Map();
  return { get: (key) => values.has(key) ? { value: values.get(key) } : undefined, set: (key, value) => values.set(key, value) };
}

test("protege mutaciones con loopback, mismo origen y token CSRF", () => {
  const cookies = jar(), token = issueCsrfToken(cookies);
  const request = new Request("http://127.0.0.1:4321/api/issues", { method: "POST", headers: { origin: "http://127.0.0.1:4321" } });
  assert.doesNotThrow(() => validateLocalMutation(request, cookies, token));
  assert.throws(() => validateLocalMutation(new Request("http://example.com/api", { headers: { origin: "http://example.com" } }), cookies, token), /loopback/);
  assert.throws(() => validateLocalMutation(new Request("http://127.0.0.1:4321/api", { headers: { origin: "http://evil.test" } }), cookies, token), /Origen/);
  assert.throws(() => validateLocalMutation(request, cookies, "0".repeat(64)), /CSRF/);
});
