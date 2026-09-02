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
  return Math.min(4000, 500 * (2 ** attempt));
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function apiError(status, data) {
  const detail = data?.error?.message || data?.message || `HTTP ${status}`;
  if (status === 403) {
    return Object.assign(new Error(`Google denegó el acceso. Comprueba que la cuenta conectada gestione la ficha, que el proyecto tenga aprobadas y habilitadas las APIs de Business Profile y que su cuota no sea 0: ${detail}`), { code: "business-profile-access-denied", status, retryable: false, nextAction: "Verifica propietario, APIs aprobadas y cuota superior a cero en Google Cloud." });
  }
  if (status === 404) return Object.assign(new Error(`Google no encontró la cuenta o ubicación solicitada: ${detail}`), { code: "business-profile-resource-not-found", status, retryable: false, nextAction: "Vuelve a listar cuentas y ubicaciones y actualiza el perfil seleccionado." });
  if (status === 429) return Object.assign(new Error(`Se agotó temporalmente la cuota de Google Business Profile: ${detail}`), { code: "business-profile-quota-exhausted", status, retryable: true, nextAction: "Espera al restablecimiento de cuota y reanuda la auditoría." });
  if (status >= 500) return Object.assign(new Error(`Google Business Profile no está disponible temporalmente: ${detail}`), { code: "business-profile-temporarily-unavailable", status, retryable: true, nextAction: "Reintenta esta fase sin bloquear el resto de la auditoría." });
  return Object.assign(new Error(`Google Business Profile devolvió un error (${status}): ${detail}`), { code: "business-profile-request-failed", status, retryable: false, nextAction: "Revisa la petición y la cobertura del recurso antes de reintentar." });
}

export class GoogleBusinessProfileClient {
  constructor({ oauth, fetchImpl = globalThis.fetch, sleep = wait } = {}) {
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async request(url) {
    let token = await this.oauth.getAccessToken();
    let refreshedAfter401 = false;
    let retryCount = 0;
    while (true) {
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
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

  listAccounts({ pageSize = 20, pageToken, filter } = {}) {
    const url = new URL("https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (filter) url.searchParams.set("filter", filter);
    return this.request(url.toString());
  }

  listLocations({ accountName, pageSize = 100, pageToken, filter, orderBy, readMask }) {
    const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`);
    url.searchParams.set("readMask", readMask);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (filter) url.searchParams.set("filter", filter);
    if (orderBy) url.searchParams.set("orderBy", orderBy);
    return this.request(url.toString());
  }

  getLocation({ locationName, readMask }) {
    const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}`);
    url.searchParams.set("readMask", readMask);
    return this.request(url.toString());
  }

  listReviews({ accountName, locationName, pageSize = 50, pageToken, orderBy = "updateTime desc" }) {
    const url = new URL(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews`);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", orderBy);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return this.request(url.toString());
  }

  listMedia({ accountName, locationName, source = "owner", pageSize = 100, pageToken }) {
    const collection = source === "customer" ? "customerMedia" : "media";
    const url = new URL(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/${collection}`);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return this.request(url.toString());
  }

  listLocalPosts({ accountName, locationName, pageSize = 20, pageToken }) {
    const url = new URL(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/localPosts`);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return this.request(url.toString());
  }

  getAttributes({ locationName }) {
    const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}/attributes`);
    return this.request(url.toString());
  }

  fetchPerformance({ locationName, dailyMetrics, startDate, endDate }) {
    const url = new URL(`https://businessprofileperformance.googleapis.com/v1/${locationName}:fetchMultiDailyMetricsTimeSeries`);
    for (const metric of dailyMetrics) url.searchParams.append("dailyMetrics", metric);
    const [startYear, startMonth, startDay] = startDate.split("-");
    const [endYear, endMonth, endDay] = endDate.split("-");
    url.searchParams.set("dailyRange.start_date.year", startYear);
    url.searchParams.set("dailyRange.start_date.month", startMonth);
    url.searchParams.set("dailyRange.start_date.day", startDay);
    url.searchParams.set("dailyRange.end_date.year", endYear);
    url.searchParams.set("dailyRange.end_date.month", endMonth);
    url.searchParams.set("dailyRange.end_date.day", endDay);
    return this.request(url.toString());
  }
}
