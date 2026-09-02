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
    return new Error(`Google denegó el acceso. Comprueba que la cuenta conectada gestione la ficha, que el proyecto tenga aprobadas y habilitadas las APIs de Business Profile y que su cuota no sea 0: ${detail}`);
  }
  if (status === 404) return new Error(`Google no encontró la cuenta o ubicación solicitada: ${detail}`);
  if (status === 429) return new Error(`Se agotó temporalmente la cuota de Google Business Profile: ${detail}`);
  if (status >= 500) return new Error(`Google Business Profile no está disponible temporalmente: ${detail}`);
  return new Error(`Google Business Profile devolvió un error (${status}): ${detail}`);
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
