import { spawn } from "node:child_process";

export const KEYCHAIN_SERVICE = "codex.google-analytics";

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const error = new Error(stderr.trim() || `security terminó con código ${code}`);
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

export class MacOSKeychain {
  constructor({ service = KEYCHAIN_SERVICE, runner = runSecurity } = {}) {
    this.service = service;
    this.runner = runner;
  }

  async get(account) {
    try {
      const encoded = await this.runner(["find-generic-password", "-s", this.service, "-a", account, "-w"]);
      return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch (error) {
      if (error.exitCode === 44) return undefined;
      throw new Error(`No se pudo leer el Llavero de macOS: ${error.message}`);
    }
  }

  async set(account, value) {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    try {
      await this.runner(["add-generic-password", "-U", "-s", this.service, "-a", account, "-w", encoded]);
    } catch (error) {
      throw new Error(`No se pudo guardar en el Llavero de macOS: ${error.message}`);
    }
  }

  async delete(account) {
    try {
      await this.runner(["delete-generic-password", "-s", this.service, "-a", account]);
      return true;
    } catch (error) {
      if (error.exitCode === 44) return false;
      throw new Error(`No se pudo eliminar la entrada del Llavero: ${error.message}`);
    }
  }
}
