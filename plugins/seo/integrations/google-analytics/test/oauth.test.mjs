import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ANALYTICS_SCOPE, CLIENT_ACCOUNT, GOOGLE_SCOPES, GoogleOAuthManager, TOKEN_ACCOUNT, createPkce, readDesktopCredentials, waitForAuthorizationCode } from "../mcp/lib/oauth.mjs";

class MemoryKeychain {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  async get(key) { return this.values.get(key); }
  async set(key, value) { this.values.set(key, value); }
  async delete(key) { return this.values.delete(key); }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const clientConfig = {
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "client-secret",
  authUri: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
};

test("PKCE genera valores S256 válidos", () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, challenge);
});

test("solo acepta credenciales de escritorio y endpoints oficiales", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ga-oauth-"));
  const file = join(directory, "client.json");
  try {
    await writeFile(file, JSON.stringify({ installed: { client_id: "123.apps.googleusercontent.com", client_secret: "secret", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token" } }));
    assert.equal((await readDesktopCredentials(file)).clientId, "123.apps.googleusercontent.com");
    await writeFile(file, JSON.stringify({ installed: { client_id: "123.apps.googleusercontent.com", client_secret: "secret", auth_uri: "https://example.com/steal", token_uri: "https://oauth2.googleapis.com/token" } }));
    await assert.rejects(readDesktopCredentials(file), /endpoint oficial/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rechaza un callback con state incorrecto", async () => {
  await assert.rejects(waitForAuthorizationCode({
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
    state: "correct-state",
    timeoutMs: 1000,
    openBrowser: async (url) => {
      const redirect = new URL(url).searchParams.get("redirect_uri");
      await fetch(`${redirect}?state=wrong-state&code=secret-code`);
    },
  }), /estado OAuth inválido/);
});

test("verifica la cuenta preferida y guarda solo el refresh token", async () => {
  const keychain = new MemoryKeychain({ [CLIENT_ACCOUNT]: clientConfig });
  const manager = new GoogleOAuthManager({
    keychain,
    timeoutMs: 1000,
    openBrowser: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("login_hint"), "admin@taxisabadell.online");
      assert.equal(parsed.searchParams.get("scope"), GOOGLE_SCOPES.join(" "));
      const redirect = parsed.searchParams.get("redirect_uri");
      const state = parsed.searchParams.get("state");
      await fetch(`${redirect}?state=${encodeURIComponent(state)}&code=test-code`);
    },
    fetchImpl: async (url) => {
      if (url === clientConfig.tokenUri) return jsonResponse({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: GOOGLE_SCOPES.join(" ") });
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") return jsonResponse({ email: "admin@taxisabadell.online" });
      throw new Error(`URL inesperada: ${url}`);
    },
  });
  const result = await manager.connect({ preferredAccountEmail: "ADMIN@taxisabadell.online" });
  assert.equal(result.accountEmail, "admin@taxisabadell.online");
  assert.deepEqual(await keychain.get(TOKEN_ACCOUNT), { refreshToken: "refresh-secret", email: "admin@taxisabadell.online", scopes: GOOGLE_SCOPES });
  assert.doesNotMatch(JSON.stringify(await keychain.get(TOKEN_ACCOUNT)), /access-secret/);
});

test("rechaza y revoca una cuenta distinta", async () => {
  const keychain = new MemoryKeychain({ [CLIENT_ACCOUNT]: clientConfig });
  let revoked = false;
  const manager = new GoogleOAuthManager({
    keychain,
    timeoutMs: 1000,
    openBrowser: async (url) => {
      const parsed = new URL(url);
      await fetch(`${parsed.searchParams.get("redirect_uri")}?state=${encodeURIComponent(parsed.searchParams.get("state"))}&code=test`);
    },
    fetchImpl: async (url) => {
      if (url === clientConfig.tokenUri) return jsonResponse({ access_token: "access", refresh_token: "refresh", scope: GOOGLE_SCOPES.join(" ") });
      if (url.includes("userinfo")) return jsonResponse({ email: "otra@gmail.com" });
      if (url.includes("revoke")) { revoked = true; return new Response("", { status: 200 }); }
      throw new Error(`URL inesperada: ${url}`);
    },
  });
  await assert.rejects(manager.connect({ preferredAccountEmail: "admin@taxisabadell.online" }), /No se guardó/);
  assert.equal(await keychain.get(TOKEN_ACCOUNT), undefined);
  assert.equal(revoked, true);
});

test("invalid_grant elimina solo el token de usuario", async () => {
  const keychain = new MemoryKeychain({ [CLIENT_ACCOUNT]: clientConfig, [TOKEN_ACCOUNT]: { refreshToken: "expired", email: "admin@taxisabadell.online", scopes: [ANALYTICS_SCOPE] } });
  const manager = new GoogleOAuthManager({ keychain, fetchImpl: async () => jsonResponse({ error: "invalid_grant", error_description: "expired" }, 400) });
  await assert.rejects(manager.getAccessToken(), /Vuelve a conectar/);
  assert.equal(await keychain.get(TOKEN_ACCOUNT), undefined);
  assert.deepEqual(await keychain.get(CLIENT_ACCOUNT), clientConfig);
});
