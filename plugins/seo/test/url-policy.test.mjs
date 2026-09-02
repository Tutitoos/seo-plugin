import test from "node:test";
import assert from "node:assert/strict";
import { assertWebTarget, isPrivateHostname } from "../src/url-policy.mjs";

test("bloquea protocolos no web y hosts privados por defecto", () => {
  assert.equal(isPrivateHostname("127.0.0.1"), true);
  assert.throws(() => assertWebTarget("file:///tmp/site"), (error) => error.code === "non-web-protocol-blocked");
  assert.throws(() => assertWebTarget("http://127.0.0.1:4321"), (error) => error.code === "private-host-blocked");
  assert.doesNotThrow(() => assertWebTarget("http://127.0.0.1:4321", { allowPrivateHosts: true }));
});
