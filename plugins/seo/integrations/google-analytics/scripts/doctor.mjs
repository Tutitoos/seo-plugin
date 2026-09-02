import { execFileSync } from "node:child_process";

const failures = [];
if (process.platform !== "darwin") failures.push("Este plugin requiere macOS para usar el Llavero del sistema.");
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isInteger(major) || major < 20) failures.push(`Se requiere Node.js 20 o posterior; versión detectada: ${process.version}.`);
try { execFileSync("security", ["help"], { stdio: "ignore" }); } catch { failures.push("No se encontró la utilidad 'security' de macOS."); }
if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Entorno compatible: macOS, ${process.version} y Llavero disponible.\n`);
}
