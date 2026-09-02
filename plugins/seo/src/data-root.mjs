import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

export function dataRoot() {
  return resolve(process.env.SEO_PLUGIN_DATA_DIR || join(homedir(), "Documents", "seo-plugin", ".seo-data"));
}

export async function ensureDataRoot() {
  const root = dataRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => {});
  return root;
}

export function insideDataRoot(...parts) {
  const root = dataRoot();
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("La ruta solicitada está fuera del almacén privado.");
  return target;
}

export function safeId(value, field = "id") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 80) {
    throw new Error(`${field} debe usar letras minúsculas, números y guiones.`);
  }
  return normalized;
}
