function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  if (status === 403) return new Error(`Google denegó el acceso. Comprueba los permisos de la cuenta y que las APIs de Analytics estén habilitadas: ${detail}`);
  if (status === 404) return new Error(`Google Analytics no encontró la propiedad o el recurso solicitado: ${detail}`);
  if (status === 429) return new Error(`Se agotó temporalmente la cuota de Google Analytics: ${detail}`);
  if (status >= 500) return new Error(`Google Analytics no está disponible temporalmente: ${detail}`);
  return new Error(`Google Analytics devolvió un error (${status}): ${detail}`);
}

export class GoogleAnalyticsClient {
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

  async listAccountSummaries({ maxPages = 5 } = {}) {
    const accountSummaries = [];
    let pageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = await this.request(url.toString());
      accountSummaries.push(...(data.accountSummaries || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return { accountSummaries, nextPageToken: pageToken || null };
  }

  getMetadata(property) {
    return this.request(`https://analyticsdata.googleapis.com/v1beta/${property}/metadata`);
  }

  runReport(property, body) {
    return this.request(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, { method: "POST", body });
  }

  runRealtimeReport(property, body) {
    return this.request(`https://analyticsdata.googleapis.com/v1beta/${property}:runRealtimeReport`, { method: "POST", body });
  }
}
