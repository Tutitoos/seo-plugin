import assert from "node:assert/strict";
import test from "node:test";
import { KEYCHAIN_SERVICE, MacOSKeychain } from "../mcp/lib/keychain.mjs";

test("codifica valores antes de entregarlos al Llavero y los recupera", async () => {
  let stored;
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "add-generic-password") { stored = args.at(-1); return ""; }
    if (args[0] === "find-generic-password") return stored;
    throw new Error("operación inesperada");
  };
  const keychain = new MacOSKeychain({ runner });
  await keychain.set("active-user", { refreshToken: "token secreto" });
  assert.doesNotMatch(stored, /token secreto/);
  assert.deepEqual(await keychain.get("active-user"), { refreshToken: "token secreto" });
  assert.equal(calls[0][3], KEYCHAIN_SERVICE);
});

test("trata una entrada ausente como undefined", async () => {
  const runner = async () => { const error = new Error("not found"); error.exitCode = 44; throw error; };
  const keychain = new MacOSKeychain({ runner });
  assert.equal(await keychain.get("missing"), undefined);
  assert.equal(await keychain.delete("missing"), false);
});
