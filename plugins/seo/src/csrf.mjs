import { randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "seo_csrf";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function issueCsrfToken(cookies) {
  let token = cookies.get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    token = randomBytes(32).toString("hex");
    cookies.set(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 60 * 60 * 8 });
  }
  return token;
}

export function validateLocalMutation(request, cookies, submittedToken) {
  const requestUrl = new URL(request.url);
  if (!LOOPBACK.has(requestUrl.hostname)) throw new Error("El tracker solo acepta peticiones desde loopback.");
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestUrl.origin) throw new Error("Origen de la petición no válido.");
  const cookieToken = cookies.get(COOKIE)?.value || "";
  const submitted = String(submittedToken || "");
  if (!/^[a-f0-9]{64}$/.test(cookieToken) || !/^[a-f0-9]{64}$/.test(submitted)) throw new Error("Token CSRF ausente o no válido.");
  if (!timingSafeEqual(Buffer.from(cookieToken), Buffer.from(submitted))) throw new Error("Token CSRF no válido.");
}
