import { createHash } from "node:crypto";

const LEGACY_TOKEN = "active-user";
const INDEX = "connected-accounts";

export function accountKey(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return LEGACY_TOKEN;
  return `user-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export class ScopedKeychain {
  constructor(base, accountEmail) {
    this.base = base;
    this.accountEmail = accountEmail?.trim().toLowerCase();
  }

  async get(account) {
    if (account !== LEGACY_TOKEN) return this.base.get(account);
    if (!this.accountEmail) return this.base.get(LEGACY_TOKEN);
    const key = accountKey(this.accountEmail);
    const current = await this.base.get(key);
    if (current) return current;
    const legacy = await this.base.get(LEGACY_TOKEN);
    if (legacy?.email?.toLowerCase() === this.accountEmail) {
      await this.base.set(key, legacy);
      await this.#remember(this.accountEmail);
      return legacy;
    }
    return undefined;
  }

  async set(account, value) {
    if (account !== LEGACY_TOKEN) return this.base.set(account, value);
    const email = value?.email?.trim().toLowerCase() || this.accountEmail;
    if (!email) return this.base.set(LEGACY_TOKEN, value);
    await this.base.set(accountKey(email), value);
    await this.#remember(email);
    return true;
  }

  async delete(account) {
    if (account !== LEGACY_TOKEN || !this.accountEmail) return this.base.delete(account);
    return this.base.delete(accountKey(this.accountEmail));
  }

  async listAccounts() { return (await this.base.get(INDEX))?.accounts || []; }

  async #remember(email) {
    const current = await this.base.get(INDEX) || { accounts: [] };
    const accounts = [...new Set([...current.accounts, email])].sort();
    await this.base.set(INDEX, { accounts });
  }
}
