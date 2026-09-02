import { insideDataRoot, safeId, ensureDataRoot } from "./data-root.mjs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";

const EMPTY = { version: 1, defaultProfileId: null, profiles: [] };
export const SERVICES = ["analytics", "searchConsole", "businessProfile"];

function cleanService(value = {}) {
  const result = {};
  for (const key of ["accountEmail", "property", "siteUrl", "accountName", "locationName"]) {
    if (typeof value[key] === "string" && value[key].trim()) result[key] = value[key].trim();
  }
  if (result.accountEmail) result.accountEmail = result.accountEmail.toLowerCase();
  return result;
}

function validateRegistry(value) {
  if (value?.version !== 1 || !Array.isArray(value.profiles)) throw new Error("profiles.json no usa el esquema compatible version=1.");
  const ids = new Set();
  for (const profile of value.profiles) {
    safeId(profile.id, "profile.id");
    if (ids.has(profile.id)) throw new Error(`Perfil duplicado: ${profile.id}.`);
    ids.add(profile.id);
    if (typeof profile.name !== "string" || !profile.name.trim()) throw new Error(`El perfil ${profile.id} no tiene nombre.`);
  }
  if (value.defaultProfileId && !ids.has(value.defaultProfileId)) throw new Error("defaultProfileId no existe.");
  return value;
}

export class ProfileStore {
  constructor({ path = insideDataRoot("config", "profiles.json"), now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
  }

  async load() {
    await ensureDataRoot();
    return validateRegistry(await readJson(this.path, EMPTY));
  }

  async save(registry) {
    validateRegistry(registry);
    await writeJsonAtomic(this.path, registry);
    return registry;
  }

  async list() { return this.load(); }

  async get(profileId) {
    const registry = await this.load();
    const id = profileId ? safeId(profileId, "profileId") : registry.defaultProfileId;
    if (!id) throw new Error("No hay perfil predeterminado. Crea uno con manage_google_profiles.");
    const profile = registry.profiles.find((item) => item.id === id);
    if (!profile) throw new Error(`No existe el perfil ${id}.`);
    return { registry, profile };
  }

  async upsert({ id, name, services = {}, setDefault = false }) {
    id = safeId(id, "profileId");
    const registry = await this.load();
    const existing = registry.profiles.find((item) => item.id === id);
    const timestamp = this.now();
    const nextServices = { ...(existing?.services || {}) };
    for (const service of SERVICES) {
      if (services[service] !== undefined) nextServices[service] = cleanService(services[service]);
    }
    const profile = {
      id,
      name: String(name || existing?.name || id).trim(),
      services: nextServices,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    registry.profiles = registry.profiles.filter((item) => item.id !== id).concat(profile);
    if (setDefault || !registry.defaultProfileId) registry.defaultProfileId = id;
    await this.save(registry);
    return { profile, defaultProfileId: registry.defaultProfileId };
  }

  async setDefault(profileId) {
    const { registry, profile } = await this.get(profileId);
    registry.defaultProfileId = profile.id;
    await this.save(registry);
    return { profile, defaultProfileId: profile.id };
  }

  async remove(profileId) {
    const { registry, profile } = await this.get(profileId);
    registry.profiles = registry.profiles.filter((item) => item.id !== profile.id);
    if (registry.defaultProfileId === profile.id) registry.defaultProfileId = registry.profiles[0]?.id || null;
    await this.save(registry);
    return { removed: profile.id, credentialsRevoked: false, defaultProfileId: registry.defaultProfileId };
  }

  async bindService(profileId, service, values) {
    if (!SERVICES.includes(service)) throw new Error(`Servicio desconocido: ${service}.`);
    const { profile } = await this.get(profileId);
    return this.upsert({ id: profile.id, name: profile.name, services: { [service]: { ...(profile.services?.[service] || {}), ...values } } });
  }
}

export async function resolveServiceProfile(profileId, service, store = new ProfileStore()) {
  const { profile } = await store.get(profileId);
  return { profile, service: profile.services?.[service] || {} };
}
