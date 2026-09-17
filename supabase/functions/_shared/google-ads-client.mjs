// Server-only Google Ads reporting adapter (Node and Deno). The adwords OAuth scope is broad;
// this module deliberately exposes only account discovery and fixed SELECTs.
// Never return token results to the browser or log provider request/response bodies.
// API v25 (July 2026); legacy campaign.start_date/end_date are intentionally absent.
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const GOOGLE_ADS_API_VERSION = 'v25';

const ACCOUNT_QUERY = `SELECT customer.id, customer.descriptive_name,
  customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status
  FROM customer LIMIT 1`;
const CHILDREN_QUERY = `SELECT customer_client.id, customer_client.client_customer,
  customer_client.descriptive_name, customer_client.currency_code,
  customer_client.time_zone, customer_client.manager, customer_client.test_account,
  customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level = 1`;
const CAMPAIGNS_QUERY = `SELECT campaign.id, campaign.name, campaign.status,
  campaign.advertising_channel_type FROM campaign ORDER BY campaign.id`;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class GoogleAdsClientError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'GoogleAdsClientError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => { throw new GoogleAdsClientError(code, status); };
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const cleanText = (value, max = 256) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
function requiredSecret(value, code) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\r\n]/.test(value)) fail(code);
  return value;
}
export function normalizeGoogleCustomerId(value) {
  if (typeof value !== 'string' || !/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value)) fail('google_customer_id_invalid');
  return value.replaceAll('-', '');
}
function entityId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) fail('google_response_id_invalid');
  return value;
}
function currencyCode(value) {
  const code = cleanText(value).toUpperCase();
  if (!CURRENCIES.has(code)) fail('google_currency_invalid');
  return code;
}
export function googleCurrencyDigits(currency) {
  return new Intl.NumberFormat('en', {style: 'currency', currency: currencyCode(currency)}).resolvedOptions().maximumFractionDigits;
}
function integerText(value, code, signed = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,25}$/ : /^\d{1,25}$/).test(value)) fail(code);
  return BigInt(value).toString();
}
function safeInteger(value, code) {
  const integer = BigInt(integerText(value ?? '0', code));
  if (integer > MAX_SAFE) fail(code);
  return Number(integer);
}
export function googleMicrosToMinor(value, currency) {
  const micros = BigInt(integerText(value, 'google_cost_invalid', true));
  const factor = 10n ** BigInt(6 - googleCurrencyDigits(currency));
  const magnitude = micros < 0n ? -micros : micros;
  const rounded = (magnitude + factor / 2n) / factor;
  if (rounded > MAX_SAFE) fail('google_cost_overflow');
  return Number(micros < 0n ? -rounded : rounded);
}
function finiteMetric(value) {
  if (value == null) return 0;
  if (!['number', 'string'].includes(typeof value) || value === '' || !Number.isFinite(Number(value))) fail('google_metric_invalid');
  return Number(value);
}
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('google_date_invalid');
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) fail('google_date_invalid');
  return millis;
}
function checkedTimezone(value) {
  const timezone = cleanText(value, 100);
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}).format(); } catch { fail('google_timezone_invalid'); }
  if (!timezone) fail('google_timezone_invalid');
  return timezone;
}
function dateInZone(millis, timezone) {
  const parts = new Intl.DateTimeFormat('en', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(millis);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function accountShape(customer, loginCustomerId = '') {
  const customerId = normalizeGoogleCustomerId(customer.id);
  const manager = customer.manager === true;
  const testAccount = customer.testAccount === true;
  return {
    customerId, loginCustomerId, name: cleanText(customer.descriptiveName) || `Google Ads ${customerId}`,
    currency: currencyCode(customer.currencyCode), timezone: checkedTimezone(customer.timeZone),
    manager, testAccount, selectable: !manager && !testAccount
  };
}
const inactiveAccount = customer => customer.status === 'CANCELED' || customer.status === 'CLOSED';
function abortError(signal) { if (signal?.aborted) fail('google_request_aborted'); }
function providerFailureCode(body) {
  // Only exact, documented enums are classified; no provider text is exposed.
  const details = record(record(body).error).details;
  let onlyInactive = Array.isArray(details) && details.length > 0 && details.length <= 20;
  let inactive = false;
  for (const detail of Array.isArray(details) ? details.slice(0, 20) : []) {
    const item = record(detail);
    if (item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && item.reason === 'SERVICE_DISABLED') return 'google_api_not_enabled';
    if (!/^type\.googleapis\.com\/google\.ads\.googleads\.v\d+\.errors\.GoogleAdsFailure$/.test(item['@type'] || '')) {
      onlyInactive = false;
      continue;
    }
    if (!Array.isArray(item.errors) || !item.errors.length || item.errors.length > 100) onlyInactive = false;
    for (const error of Array.isArray(item.errors) ? item.errors.slice(0, 100) : []) {
      const code = record(record(error).errorCode);
      if (code.authorizationError === 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION') return 'google_cloud_project_access_required';
      if (code.authenticationError === 'NOT_ADS_USER') return 'google_ads_user_required';
      if (Object.keys(code).length === 1 && code.authorizationError === 'CUSTOMER_NOT_ENABLED') inactive = true;
      else onlyInactive = false;
    }
  }
  // Never hide an authorization or unknown failure mixed with an inactive account.
  return inactive && onlyInactive ? 'google_customer_not_enabled' : '';
}
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GoogleAdsClientError('google_request_aborted'));
    const onAbort = () => { clearTimeout(timer); reject(new GoogleAdsClientError('google_request_aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

export function createGoogleAdsClient(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const limit = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  const maxPages = limit(options.maxPages, 10, 100);
  const maxRows = limit(options.maxRows, 50000, 50000);
  const maxAccounts = limit(options.maxAccounts, 100, 500);
  const timeoutMs = limit(options.timeoutMs, 15000, 30000);
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? Math.min(options.maxRetries, 2) : 2;
  const apiVersion = config.apiVersion || GOOGLE_ADS_API_VERSION;
  if (apiVersion !== GOOGLE_ADS_API_VERSION) fail('google_api_version_unsupported');
  const clientId = requiredSecret(config.clientId, 'google_client_id_missing');
  const clientSecret = requiredSecret(config.clientSecret, 'google_client_secret_missing');
  // Google Ads access now belongs to the OAuth client's Cloud project.
  let redirectUri;
  try {
    const url = new URL(config.redirectUri);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('google_redirect_uri_invalid');
    redirectUri = url.toString();
  } catch { fail('google_redirect_uri_invalid'); }

  async function requestJson(url, init, signal, retries = maxRetries) {
    const externalSignal = signal || options.signal;
    for (let attempt = 0; attempt <= retries; attempt++) {
      abortError(externalSignal);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onAbort, {once: true});
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let response, body;
      try {
        response = await fetchImpl(url, {...init, signal: controller.signal, redirect: 'error', cache: 'no-store'});
        if (Number(response.headers.get('content-length') || 0) > 8_000_000) fail('google_response_too_large');
        const text = await response.text();
        if (text.length > 8_000_000) fail('google_response_too_large');
        try { body = JSON.parse(text); } catch { body = null; }
      } catch (error) {
        if (error instanceof GoogleAdsClientError) throw error;
        if (externalSignal?.aborted) fail('google_request_aborted');
        if (timedOut) fail('google_request_timeout');
        fail('google_network_error');
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onAbort);
      }
      abortError(externalSignal);
      if (response.ok) {
        if (!body || Array.isArray(body) || typeof body !== 'object') fail('google_response_invalid');
        return body;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < retries) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0;
        const delay = Math.min(Math.max(250 * (2 ** attempt), seconds * 1000), 3000);
        await sleep(delay, externalSignal);
        continue;
      }
      // Never expose Google's error message, details, URLs or body: these can contain secrets.
      if (record(body).error === 'invalid_client') fail('google_oauth_configuration_invalid', response.status);
      const providerCode = providerFailureCode(body);
      if (providerCode && (providerCode !== 'google_customer_not_enabled' || response.status === 403)) fail(providerCode, response.status);
      if (record(body).error === 'invalid_grant' || response.status === 401) fail('google_reconnect_required', response.status);
      if (response.status === 403) fail('google_access_denied', response.status);
      if (response.status === 429) fail('google_rate_limited', response.status);
      fail('google_api_error', response.status);
    }
  }
  function adsHeaders(accessToken, loginCustomerId = '') {
    return {
      authorization: `Bearer ${requiredSecret(accessToken, 'google_access_token_missing')}`,
      'content-type': 'application/json',
      ...(loginCustomerId ? {'login-customer-id': normalizeGoogleCustomerId(loginCustomerId)} : {})
    };
  }
  async function search(accessToken, customerId, loginCustomerId, query, signal) {
    customerId = normalizeGoogleCustomerId(customerId);
    const rows = [], tokens = new Set();
    let pageToken = '';
    for (let page = 0; page < maxPages; page++) {
      const body = await requestJson(`https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`, {
        method: 'POST', headers: adsHeaders(accessToken, loginCustomerId),
        body: JSON.stringify({query, ...(pageToken ? {pageToken} : {})})
      }, signal);
      if (body.results != null && !Array.isArray(body.results)) fail('google_response_invalid');
      rows.push(...(body.results || []));
      if (rows.length > maxRows) fail('google_result_limit_exceeded');
      if (!body.nextPageToken) return rows;
      if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 8192 || tokens.has(body.nextPageToken)) fail('google_pagination_invalid');
      pageToken = body.nextPageToken;
      tokens.add(pageToken);
    }
    fail('google_page_limit_exceeded');
  }
  async function identity(accessToken, customerId, loginCustomerId, signal) {
    const rows = await search(accessToken, customerId, loginCustomerId, ACCOUNT_QUERY, signal);
    if (rows.length !== 1) fail('google_account_identity_missing');
    const customer = record(record(rows[0]).customer);
    if (normalizeGoogleCustomerId(customer.id) !== normalizeGoogleCustomerId(customerId)) fail('google_account_mismatch');
    if (inactiveAccount(customer)) fail('google_customer_not_enabled');
    return accountShape(customer, loginCustomerId);
  }
  function tokenShape(body, previousRefreshToken) {
    if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') fail('google_token_type_invalid');
    const accessToken = requiredSecret(body.access_token, 'google_token_invalid');
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
    if (!scopes.includes(GOOGLE_ADS_SCOPE)) fail('google_scope_missing');
    const expiresIn = Number(body.expires_in);
    if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 86400) fail('google_token_expiry_invalid');
    const refreshToken = body.refresh_token || previousRefreshToken;
    return {
      accessToken, ...(refreshToken ? {refreshToken: requiredSecret(refreshToken, 'google_refresh_token_invalid')} : {}),
      expiresAt: new Date(now() + expiresIn * 1000).toISOString(), scope: scopes.join(' '), tokenType: 'Bearer'
    };
  }
  return Object.freeze({
    authorizationUrl({state, codeChallenge, includeAnalytics=false}) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) fail('google_state_invalid');
      if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) fail('google_pkce_invalid');
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: GOOGLE_ADS_SCOPE+(includeAnalytics ? ' https://www.googleapis.com/auth/analytics.readonly' : ''), state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false'}).toString();
      return url.toString();
    },
    async exchangeCode({code, codeVerifier, signal}) {
      if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) fail('google_pkce_invalid');
      const body = await requestJson('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'authorization_code', code: requiredSecret(code, 'google_code_missing'),
          client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code_verifier: codeVerifier}).toString()
      }, signal, 0);
      return tokenShape(body);
    },
    async refreshAccessToken({refreshToken, signal}) {
      refreshToken = requiredSecret(refreshToken, 'google_refresh_token_missing');
      const body = await requestJson('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken,
          client_id: clientId, client_secret: clientSecret}).toString()
      }, signal);
      return tokenShape(body, refreshToken);
    },
    async discoverAccounts({accessToken, signal}) {
      const body = await requestJson(`https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`, {
        method: 'GET', headers: adsHeaders(accessToken)
      }, signal);
      if (body.resourceNames != null && !Array.isArray(body.resourceNames)) fail('google_response_invalid');
      const roots = [...new Set((body.resourceNames || []).map(resource => {
        if (typeof resource !== 'string' || !/^customers\/\d{10}$/.test(resource)) fail('google_response_id_invalid');
        return normalizeGoogleCustomerId(resource.slice(10));
      }))];
      if (roots.length > maxAccounts) fail('google_account_limit_exceeded');
      const accounts = new Map(), queue = [], visited = new Set();
      const seen = new Set(roots), unavailable = new Set();
      const skipInactive = (error, customerId) => {
        if (!(error instanceof GoogleAdsClientError) || error.code !== 'google_customer_not_enabled') throw error;
        unavailable.add(customerId);
      };
      // Direct access wins over manager routes for the same advertiser.
      for (const root of roots) {
        let account;
        try { account = await identity(accessToken, root, '', signal); }
        catch (error) { skipInactive(error, root); continue; }
        accounts.set(root, account);
        if (account.manager && !account.testAccount) queue.push({customerId: root, loginCustomerId: root});
      }
      while (queue.length) {
        const route = queue.shift();
        if (visited.has(route.customerId)) continue;
        visited.add(route.customerId);
        let rows;
        try { rows = await search(accessToken, route.customerId, route.loginCustomerId, CHILDREN_QUERY, signal); }
        catch (error) {
          skipInactive(error, route.customerId);
          accounts.delete(route.customerId);
          continue;
        }
        for (const row of rows) {
          const customer = record(record(row).customerClient);
          const customerId = normalizeGoogleCustomerId(customer.id);
          seen.add(customerId);
          if (seen.size > maxAccounts) fail('google_account_limit_exceeded');
          // Closed accounts may have no currency/timezone and cannot be selected.
          if (inactiveAccount(customer)) { unavailable.add(customerId); continue; }
          const child = accountShape(customer, route.loginCustomerId);
          if (!accounts.has(child.customerId)) accounts.set(child.customerId, child);
          if (child.manager && !child.testAccount && !visited.has(child.customerId)) queue.push({customerId: child.customerId, loginCustomerId: route.loginCustomerId});
        }
      }
      return {accounts: [...accounts.values()].sort((a, b) => a.customerId.localeCompare(b.customerId)), truncated: false,
        unavailableAccountCount: [...unavailable].filter(id => !accounts.has(id)).length};
    },
    async revalidateAccount({accessToken, account, signal}) {
      const result = await identity(accessToken, account.customerId, account.loginCustomerId || '', signal);
      if (!result.selectable) fail('google_advertiser_account_required');
      return result;
    },
    async fetchCampaignReport({accessToken, account, dateFrom, dateTo, signal}) {
      const start = dateValue(dateFrom), end = dateValue(dateTo);
      if (start > end || (end - start) / 86400000 >= 31) fail('google_date_range_invalid');
      // Revalidate access on every synchronization, not only when the user selected the account.
      const verified = await identity(accessToken, account.customerId, account.loginCustomerId || '', signal);
      if (!verified.selectable) fail('google_advertiser_account_required');
      if (dateTo > dateInZone(now(), verified.timezone)) fail('google_date_future');
      const campaignRows = await search(accessToken, verified.customerId, verified.loginCustomerId, CAMPAIGNS_QUERY, signal);
      const campaigns = campaignRows.map(row => {
        const campaign = record(record(row).campaign);
        return {externalCampaignId: entityId(campaign.id), name: cleanText(campaign.name),
          status: cleanText(campaign.status, 40), channelType: cleanText(campaign.advertisingChannelType, 40)};
      });
      const metricRows = await search(accessToken, verified.customerId, verified.loginCustomerId, `SELECT
        campaign.id, segments.date, metrics.cost_micros, metrics.impressions,
        metrics.clicks, metrics.conversions, metrics.conversions_value
        FROM campaign WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
        ORDER BY segments.date, campaign.id`, signal);
      const keys = new Set();
      const daily = metricRows.map(row => {
        const campaign = record(record(row).campaign), metrics = record(record(row).metrics);
        const externalCampaignId = entityId(campaign.id), date = record(record(row).segments).date;
        dateValue(date);
        if (date < dateFrom || date > dateTo) fail('google_response_date_invalid');
        const key = `${externalCampaignId}:${date}`;
        if (keys.has(key)) fail('google_response_duplicate_metric');
        keys.add(key);
        const costMicros = integerText(metrics.costMicros ?? '0', 'google_cost_invalid', true);
        return {date, externalCampaignId, costMicros, costMinor: googleMicrosToMinor(costMicros, verified.currency),
          impressions: safeInteger(metrics.impressions, 'google_impressions_invalid'),
          clicks: safeInteger(metrics.clicks, 'google_clicks_invalid'),
          googleConversions: finiteMetric(metrics.conversions), googleConversionValue: finiteMetric(metrics.conversionsValue),
          currency: verified.currency};
      });
      return {account: verified, campaigns, daily, dateFrom, dateTo};
    }
  });
}
