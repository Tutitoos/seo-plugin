import { spawnSync } from "node:child_process";
import { ProfileStore } from "./profile-store.mjs";
import { accountKey } from "./scoped-keychain.mjs";

const config = {
  analytics: { label: "Google Analytics", service: "codex.google-analytics", scope: "analytics.readonly", sees: "Cuentas, propiedades, dimensiones, métricas e informes GA4" },
  searchConsole: { label: "Google Search Console", service: "codex.google-search-console", scope: "webmasters.readonly", sees: "Propiedades, rendimiento, indexación y sitemaps" },
  businessProfile: { label: "Google Business Profile", service: "codex.google-business-profile", scope: "business.manage (herramientas de lectura)", sees: "Cuentas, fichas, imágenes, atributos, reseñas, publicaciones y métricas; caché privada máxima de 30 días" },
};

function hasKeychainItem(service, account) {
  return spawnSync("security", ["find-generic-password", "-s", service, "-a", account], { stdio: "ignore" }).status === 0;
}

export async function accessStatus() {
  const registry = await new ProfileStore().list();
  return {
    ...registry,
    profiles: registry.profiles.map((profile) => ({
      ...profile,
      services: Object.fromEntries(Object.entries(config).map(([key, details]) => {
        const accountEmail = profile.services?.[key]?.accountEmail;
        const connected = Boolean(accountEmail && (hasKeychainItem(details.service, accountKey(accountEmail)) || hasKeychainItem(details.service, "active-user")));
        return [key, { ...details, accountEmail: accountEmail || null, connected, defaults: profile.services?.[key] || {} }];
      })),
    })),
  };
}
