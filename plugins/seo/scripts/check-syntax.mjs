import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") output.push(...await files(path));
    else if (entry.isFile() && path.endsWith(".mjs")) output.push(path);
  }
  return output;
}

for (const path of await files(new URL("..", import.meta.url).pathname)) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
