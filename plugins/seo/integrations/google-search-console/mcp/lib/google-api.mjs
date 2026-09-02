function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(4000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 200);
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function apiError(status, data) {
  const detail = data?.error?.message || data?.message || `HTTP ${status}`;
  if (status === 403) return new Error(`Google denegó el acceso. Comprueba que la cuenta tenga permisos sobre esta propiedad: ${detail}`);
  if (status === 429) return new Error(`Se agotó temporalmente la cuota de Search Console: ${detail}`);
  if (status >= 500) return new Error(`Google Search Console no está disponible temporalmente: ${detail}`);
  return new Error(`Google Search Console devolvió un error (${status}): ${detail}`);
}

export class GoogleSearchConsoleClient {
  constructor({ oauth, fetchImpl = globalThis.fetch, sleep = wait } = {}) {
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async request(url, { method = "GET", body } = {}) {
    let token = await this.oauth.getAccessToken();
    let refreshedAfter401 = false;
    let retryCount = 0;
    while (true) {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        token = await this.oauth.getAccessToken({ forceRefresh: true });
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retryCount < 2) {
        await this.sleep(retryDelay(response, retryCount));
        retryCount += 1;
        continue;
      }
      const data = await responseData(response);
      if (!response.ok) throw apiError(response.status, data);
      return data;
    }
  }

  listSites() {
    return this.request("https://www.googleapis.com/webmasters/v3/sites");
  }

  queryPerformance(siteUrl, query) {
    return this.request(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: "POST", body: query },
    );
  }

  inspectUrl(siteUrl, inspectionUrl, languageCode) {
    return this.request("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      body: {
        siteUrl,
        inspectionUrl,
        ...(languageCode ? { languageCode } : {}),
      },
    });
  }

  listSitemaps(siteUrl, sitemapIndex) {
    const url = new URL(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
    if (sitemapIndex) url.searchParams.set("sitemapIndex", sitemapIndex);
    return this.request(url.toString());
  }
}
