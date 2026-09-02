import test from "node:test";
import assert from "node:assert/strict";
import { ScopedKeychain, accountKey } from "../src/scoped-keychain.mjs";

class MemoryKeychain {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) { return this.values.get(key); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return true; }
  async delete(key) { return this.values.delete(key); }
}

test("migra la cuenta legacy sin destruirla", async () => {
  const legacy = { email: "admin@example.com", refreshToken: "secret" };
  const base = new MemoryKeychain({ "active-user": legacy });
  const scoped = new ScopedKeychain(base, "admin@example.com");
  assert.deepEqual(await scoped.get("active-user"), legacy);
  assert.deepEqual(await base.get(accountKey("admin@example.com")), legacy);
  assert.deepEqual(await base.get("active-user"), legacy);
});

test("aísla tokens de varias cuentas", async () => {
  const base = new MemoryKeychain();
  const first = new ScopedKeychain(base, "one@example.com");
  const second = new ScopedKeychain(base, "two@example.com");
  await first.set("active-user", { email: "one@example.com", refreshToken: "one" });
  await second.set("active-user", { email: "two@example.com", refreshToken: "two" });
  assert.equal((await first.get("active-user")).refreshToken, "one");
  assert.equal((await second.get("active-user")).refreshToken, "two");
  assert.deepEqual(await second.listAccounts(), ["one@example.com", "two@example.com"]);
});
