import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function markdownFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await markdownFiles(path));
    else if (entry.isFile() && path.endsWith(".md")) output.push(path);
  }
  return output;
}

const pluginRoot = resolve(new URL("..", import.meta.url).pathname);
const roots = [join(pluginRoot, "skills"), join(pluginRoot, "tools")];
const missing = [];
for (const root of roots) {
  for (const file of await markdownFiles(root)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const raw = match[1].split(/\s+["']/)[0].split("#")[0];
      if (!raw || /^(?:https?:|mailto:|\/)/.test(raw)) continue;
      const target = resolve(dirname(file), decodeURIComponent(raw));
      try { await stat(target); } catch { missing.push(`${file}: ${raw}`); }
    }
  }
}
if (missing.length) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log("Todos los enlaces Markdown relativos apuntan a archivos existentes.");
