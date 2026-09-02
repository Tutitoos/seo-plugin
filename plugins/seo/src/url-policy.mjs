import { isIP } from "node:net";

export function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/[\[\]]/g, "");
  if (["localhost", "localhost.localdomain"].includes(host) || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (isIP(host) === 6) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  return false;
}

export function assertWebTarget(value, { allowPrivateHosts = false } = {}) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) { const error = new Error(`El rastreo solo admite HTTP/HTTPS, no ${url.protocol || "este protocolo"}.`); error.code = "non-web-protocol-blocked"; throw error; }
  if (!allowPrivateHosts && isPrivateHostname(url.hostname)) { const error = new Error(`El rastreo bloquea el host privado ${url.hostname}.`); error.code = "private-host-blocked"; throw error; }
  return url;
}
