import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  const data = {};
  if (!match) return data;
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return data;
}

function category(name) {
  if (name.startsWith("google-")) return "Google";
  if (["seo-audit", "ai-seo", "programmatic-seo", "site-architecture", "schema", "aso"].includes(name)) return "SEO y descubrimiento";
  if (["analytics", "attribution", "ab-testing"].includes(name)) return "Medición";
  if (["copywriting", "copy-editing", "content-strategy", "emails", "social", "video", "image", "sms", "cold-email"].includes(name)) return "Contenido";
  if (["cro", "signup", "onboarding", "popups", "paywalls"].includes(name)) return "Conversión";
  return "Marketing y crecimiento";
}

export async function skillCatalog() {
  const entries = await readdir(root, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(root, entry.name, "SKILL.md"), "utf8");
      const meta = frontmatter(raw);
      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || "Sin descripción.",
        category: category(entry.name),
        source: entry.name.startsWith("google-") ? "SEO Plugin" : "Marketing Skills",
        access: entry.name.startsWith("google-") ? "API Google de solo lectura" : "No concede permisos; usa las herramientas disponibles en la tarea",
      });
    } catch {}
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
