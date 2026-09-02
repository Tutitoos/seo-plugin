import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export const GOOGLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
]);

export const CLIENT_ACCOUNT = "oauth-client";
export const TOKEN_ACCOUNT = "active-user";

export function createPkce() {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState() {
  return randomBytes(32).toString("base64url");
}

function assertGoogleEndpoint(raw, expectedHost, field) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`El campo ${field} del JSON OAuth no contiene una URL válida.`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost) {
    throw new Error(`El campo ${field} no apunta al endpoint oficial esperado de Google.`);
  }
  return parsed.toString();
}

export async function readDesktopCredentials(credentialsFile) {
  if (!isAbsolute(credentialsFile)) {
    throw new Error("credentialsFile debe ser una ruta absoluta al JSON OAuth descargado.");
  }
  const info = await stat(credentialsFile);
  if (!info.isFile() || info.size > 64 * 1024) {
    throw new Error("El archivo de credenciales no es un JSON OAuth de tamaño válido.");
  }
  const parsed = JSON.parse(await readFile(credentialsFile, "utf8"));
  const installed = parsed?.installed;
  if (!installed || typeof installed.client_id !== "string" || typeof installed.client_secret !== "string") {
    throw new Error("El JSON debe pertenecer a un cliente OAuth de tipo Aplicación de escritorio.");
  }
  if (!installed.client_id.endsWith(".apps.googleusercontent.com")) {
    throw new Error("El client_id del JSON OAuth no tiene el formato esperado de Google.");
  }
  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    authUri: assertGoogleEndpoint(
      installed.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth",
      "accounts.google.com",
      "auth_uri",
    ),
    tokenUri: assertGoogleEndpoint(
      installed.token_uri || "https://oauth2.googleapis.com/token",
      "oauth2.googleapis.com",
      "token_uri",
    ),
  };
}

function defaultOpenBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return 500 * (2 ** attempt);
}

function accessExpiry(expiresIn) {
  const lifetime = Number(expiresIn);
  const safeLifetime = Number.isFinite(lifetime) ? Math.max(0, lifetime - 60) : 3540;
  return Date.now() + safeLifetime * 1000;
}

function html(message, success) {
  const color = success ? "#137333" : "#b3261e";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Google Search Console</title><style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:15vh auto;padding:24px;color:#202124}h1{color:${color}}</style></head><body><h1>${success ? "Autorización recibida" : "No se pudo autorizar"}</h1><p>${message}</p><p>Ya puedes cerrar esta pestaña y volver a Codex.</p></body></html>`;
}

export async function waitForAuthorizationCode({ authUrl, state, openBrowser = defaultOpenBrowser, timeoutMs = 240_000 }) {
  let settled = false;
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The browser callback can arrive before openBrowser() resolves. Attach a
  // rejection observer immediately, then await the original promise below.
  codePromise.catch(() => {});

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (settled) {
      response.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html("La autorización ya se ha procesado.", false));
      return;
    }
    if (requestUrl.searchParams.get("state") !== state) {
      settled = true;
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html("El estado OAuth no coincide. No se ha guardado ninguna credencial.", false));
      rejectCode(new Error("Google devolvió un estado OAuth inválido."));
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      settled = true;
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html("Google canceló o rechazó la autorización.", false));
      rejectCode(new Error(`Google no autorizó la conexión: ${oauthError}.`));
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html("La respuesta no contiene un código OAuth.", false));
      return;
    }
    settled = true;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html("Google ha devuelto la autorización al plugin.", true));
    resolveCode(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const url = new URL(authUrl);
  url.searchParams.set("redirect_uri", redirectUri);

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("La autorización OAuth agotó el tiempo de espera."));
    }
  }, timeoutMs);

  try {
    await openBrowser(url.toString());
    return { code: await codePromise, redirectUri };
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function parseJsonResponse(response, context) {
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = {}; }
  }
  if (!response.ok) {
    const code = data?.error;
    const detail = data?.error_description || data?.error?.message || response.statusText;
    const error = new Error(`${context}: ${detail || `HTTP ${response.status}`}`);
    error.oauthCode = typeof code === "string" ? code : undefined;
    error.status = response.status;
    throw error;
  }
  return data;
}

export class GoogleOAuthManager {
  constructor({ keychain, fetchImpl = globalThis.fetch, openBrowser = defaultOpenBrowser, timeoutMs = 240_000, sleep = delay } = {}) {
    this.keychain = keychain;
    this.fetchImpl = fetchImpl;
    this.openBrowser = openBrowser;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.access = undefined;
  }

  async configure(credentialsFile) {
    const config = await readDesktopCredentials(credentialsFile);
    await this.keychain.set(CLIENT_ACCOUNT, config);
    return config;
  }

  async status({ verify = true } = {}) {
    const token = await this.keychain.get(TOKEN_ACCOUNT);
    if (!token?.refreshToken) return { connected: false, needsReconnect: true };
    if (verify) await this.getAccessToken();
    return {
      connected: true,
      needsReconnect: false,
      accountEmail: token.email,
      scopes: token.scopes || GOOGLE_SCOPES,
    };
  }

  async connect({ credentialsFile, forceAccountSelection = false, preferredAccountEmail } = {}) {
    if (credentialsFile) await this.configure(credentialsFile);
    const existing = await this.keychain.get(TOKEN_ACCOUNT);
    if (existing?.refreshToken && !forceAccountSelection) {
      return {
        ...(await this.status()),
        message: "Ya hay una cuenta conectada. Usa forceAccountSelection para sustituirla.",
      };
    }
    const config = await this.keychain.get(CLIENT_ACCOUNT);
    if (!config?.clientId || !config?.clientSecret) {
      throw new Error("Falta el cliente OAuth. Indica credentialsFile con la ruta absoluta al JSON de una Aplicación de escritorio.");
    }

    const expectedEmail = typeof preferredAccountEmail === "string" ? preferredAccountEmail.trim().toLowerCase() : undefined;
    const { verifier, challenge } = createPkce();
    const state = createState();
    const authUrl = new URL(config.authUri);
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", (forceAccountSelection || expectedEmail) ? "select_account consent" : "consent");
    if (expectedEmail) authUrl.searchParams.set("login_hint", expectedEmail);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const { code, redirectUri } = await waitForAuthorizationCode({
      authUrl: authUrl.toString(),
      state,
      openBrowser: this.openBrowser,
      timeoutMs: this.timeoutMs,
    });

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const response = await this.fetchImpl(config.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokens = await parseJsonResponse(response, "No se pudo intercambiar el código OAuth");
    if (!tokens.refresh_token || !tokens.access_token) {
      throw new Error("Google no devolvió un refresh token. Revoca el acceso anterior y vuelve a conectar.");
    }
    const userInfoResponse = await this.fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await parseJsonResponse(userInfoResponse, "No se pudo identificar la cuenta conectada");
    const actualEmail = typeof userInfo.email === "string" ? userInfo.email.trim().toLowerCase() : undefined;
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : GOOGLE_SCOPES;
    if (!scopes.includes("https://www.googleapis.com/auth/webmasters.readonly")) {
      throw new Error("Google no concedió el permiso de solo lectura de Search Console.");
    }
    if (expectedEmail && actualEmail !== expectedEmail) {
      await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refresh_token }),
      }).catch(() => {});
      throw new Error(`Se autorizó ${actualEmail || "otra cuenta"}, pero se esperaba ${expectedEmail}. No se guardó la sesión.`);
    }
    await this.keychain.set(TOKEN_ACCOUNT, {
      refreshToken: tokens.refresh_token,
      email: actualEmail || "Cuenta de Google",
      scopes,
    });
    this.access = {
      token: tokens.access_token,
      expiresAt: accessExpiry(tokens.expires_in),
    };
    return {
      connected: true,
      needsReconnect: false,
      accountEmail: actualEmail || "Cuenta de Google",
      scopes,
    };
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.access?.token && this.access.expiresAt > Date.now()) return this.access.token;
    const [config, saved] = await Promise.all([
      this.keychain.get(CLIENT_ACCOUNT),
      this.keychain.get(TOKEN_ACCOUNT),
    ]);
    if (!config?.clientId || !saved?.refreshToken) {
      throw new Error("No hay una cuenta conectada. Usa manage_google_connection con action=connect.");
    }
    const response = await this.fetchImpl(config.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: saved.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    try {
      const tokens = await parseJsonResponse(response, "No se pudo renovar la sesión de Google");
      this.access = {
        token: tokens.access_token,
        expiresAt: accessExpiry(tokens.expires_in),
      };
      return this.access.token;
    } catch (error) {
      if (error.oauthCode === "invalid_grant") {
        this.access = undefined;
        await this.keychain.delete(TOKEN_ACCOUNT);
        throw new Error("La autorización de Google ha caducado o fue revocada. Vuelve a conectar la cuenta.");
      }
      throw error;
    }
  }

  async disconnect() {
    const saved = await this.keychain.get(TOKEN_ACCOUNT);
    if (!saved?.refreshToken) {
      this.access = undefined;
      return { connected: false, revoked: false, message: "No había ninguna cuenta conectada." };
    }
    let response;
    let lastNetworkError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: saved.refreshToken }),
        });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await this.sleep(retryDelay(response, attempt));
          continue;
        }
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempt < 2) {
          await this.sleep(500 * (2 ** attempt));
          continue;
        }
      }
    }
    if (!response) {
      throw new Error(`No se pudo contactar con Google para revocar la sesión; se conserva el token para reintentar: ${lastNetworkError?.message || "error de red"}`);
    }
    if (!response.ok && response.status !== 400) {
      throw new Error(`Google no confirmó la revocación (HTTP ${response.status}); se conserva el token para reintentar.`);
    }
    await this.keychain.delete(TOKEN_ACCOUNT);
    this.access = undefined;
    return { connected: false, revoked: true };
  }
}
