type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key: string]: Json};

type JsonRecord = {[key: string]: Json};

type WooEntity =
  | 'categories'
  | 'attributes'
  | 'attribute_terms'
  | 'products'
  | 'variations'
  | 'coupons'
  | 'orders'
  | 'customers';

type ConnectionConfiguration = {
  connectionId: string;
  tenantId: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  syncScope: Json;
  lastSyncedAt: string;
};

type WooClient = {
  apiBase: URL;
  authorization: string;
};

type WooResponse = {
  data: Json;
  headers: Headers;
};

type PageCursor = {
  page: number;
  totalPages: number | null;
  totalItems: number | null;
  nextPage: number | null;
  parentId?: string | number;
};

type SyncStats = {
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  scope: WooEntity[];
  totals: Partial<Record<WooEntity, number>>;
  pages: Partial<Record<WooEntity, number>>;
};

const ALL_ENTITIES: WooEntity[] = [
  'categories',
  'attributes',
  'attribute_terms',
  'products',
  'variations',
  'coupons',
  'orders',
  'customers'
];

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_REMOTE_ATTEMPTS = 4;
const REMOTE_TIMEOUT_MS = 25_000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_PAGES_PER_COLLECTION = 500;

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, content-type, x-idempotency-key, '
    + 'x-marktone-woocommerce-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
  vary: 'Origin'
};

const jsonHeaders = {
  ...corsHeaders,
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0'
};

class IntegrationError extends Error {
  code: string;
  status: number;

  constructor(code: string, status = 500) {
    super(code);
    this.name = 'IntegrationError';
    this.code = code;
    this.status = status;
  }
}

class RpcError extends IntegrationError {
  constructor(name: string, status: number) {
    super(`woocommerce_rpc_${name}_${status}`, status === 401 ? 401 : 500);
    this.name = 'RpcError';
  }
}

function env(name: string) {
  return Deno.env.get(name)?.trim() || '';
}

function json(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders
  });
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function unwrapRpcValue(value: Json): Json {
  if (Array.isArray(value) && value.length === 1) {
    return unwrapRpcValue(value[0]);
  }
  return value;
}

function textValue(value: unknown) {
  return value == null ? '' : String(value).trim();
}

function recordValue(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value != null) return value;
  }
  return null;
}

function recordText(record: JsonRecord, ...keys: string[]) {
  return textValue(recordValue(record, ...keys));
}

function pathValue(record: JsonRecord, ...paths: string[]): Json {
  for (const path of paths) {
    let current: Json = record;
    let found = true;
    for (const part of path.split('.')) {
      const object = asRecord(current);
      if (!object || !(part in object)) {
        found = false;
        break;
      }
      current = object[part];
    }
    if (found && current != null) return current;
  }
  return null;
}

function metadataValues(record: JsonRecord) {
  const result: JsonRecord = {};
  if (!Array.isArray(record.meta_data)) return result;
  for (const entry of record.meta_data) {
    const item = asRecord(entry);
    const key = item ? recordText(item, 'key') : '';
    if (item && key) result[key] = recordValue(item, 'value');
  }
  return result;
}

function trackedOrderValue(
  order: JsonRecord,
  metadata: JsonRecord,
  ...keys: string[]
) {
  for (const key of keys) {
    const direct = pathValue(order, key, `tracking.${key}`, `attribution.${key}`);
    if (textValue(direct)) return textValue(direct);
    for (const alias of [
      key,
      `_${key}`,
      `_wc_order_attribution_${key.replace(/^utm_/, 'utm_')}`
    ]) {
      if (textValue(metadata[alias])) return textValue(metadata[alias]);
    }
  }
  return '';
}

function orderAttribution(order: JsonRecord): JsonRecord {
  const metadata = metadataValues(order);
  const clickEntries = [
    ['gclid', trackedOrderValue(order, metadata, 'gclid')],
    ['gbraid', trackedOrderValue(order, metadata, 'gbraid')],
    ['wbraid', trackedOrderValue(order, metadata, 'wbraid')],
    ['fbclid', trackedOrderValue(order, metadata, 'fbclid', 'fbc')],
    ['ttclid', trackedOrderValue(order, metadata, 'ttclid')],
    ['sc_click_id', trackedOrderValue(order, metadata, 'sc_click_id')]
  ].filter(([, value]) => Boolean(value));
  const [clickIdType, clickId] = clickEntries[0] || ['', ''];
  return {
    source: trackedOrderValue(
      order,
      metadata,
      'source',
      'source_type',
      'utm_source'
    ),
    clickIdType,
    clickId,
    utmSource: trackedOrderValue(order, metadata, 'utm_source'),
    utmMedium: trackedOrderValue(order, metadata, 'utm_medium'),
    utmCampaign: trackedOrderValue(order, metadata, 'utm_campaign'),
    utmContent: trackedOrderValue(order, metadata, 'utm_content'),
    utmTerm: trackedOrderValue(order, metadata, 'utm_term'),
    externalCampaignId: trackedOrderValue(
      order,
      metadata,
      'external_campaign_id',
      'campaign_id'
    ),
    externalAdGroupId: trackedOrderValue(
      order,
      metadata,
      'external_ad_group_id',
      'adset_id',
      'ad_group_id'
    ),
    externalAdId: trackedOrderValue(
      order,
      metadata,
      'external_ad_id',
      'ad_id'
    ),
    landingUrl: trackedOrderValue(
      order,
      metadata,
      'landing_url',
      'session_entry'
    ),
    referrerUrl: trackedOrderValue(order, metadata, 'referrer_url', 'referrer')
  };
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = textValue(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed == null || parsed < 0) return null;
  return Math.trunc(parsed);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function parseJsonSafely(text: string): Json {
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new IntegrationError('invalid_json_response', 502);
  }
}

function dictionaryKey(envName: string) {
  const raw = env(envName);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '';
    }
    const values = Object.values(parsed);
    return values.length ? textValue(values[0]) : '';
  } catch {
    return '';
  }
}

function configuredKeys() {
  const publishableKey =
    env('SUPABASE_ANON_KEY')
    || env('SUPABASE_PUBLISHABLE_KEY')
    || dictionaryKey('SUPABASE_PUBLISHABLE_KEYS');
  const serviceRoleKey =
    env('SUPABASE_SERVICE_ROLE_KEY')
    || env('SUPABASE_SECRET_KEY')
    || dictionaryKey('SUPABASE_SECRET_KEYS');
  return {
    supabaseUrl: env('SUPABASE_URL'),
    publishableKey,
    serviceRoleKey
  };
}

async function rpc(
  supabaseUrl: string,
  apiKey: string,
  bearerToken: string | null,
  name: string,
  body: JsonRecord
): Promise<Json> {
  const headers: Record<string, string> = {
    apikey: apiKey,
    'content-type': 'application/json',
    accept: 'application/json'
  };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error'
  });
  const payload = await response.text();
  if (!response.ok) throw new RpcError(name, response.status);
  return payload ? parseJsonSafely(payload) : null;
}

function rpcAsService(
  keys: ReturnType<typeof configuredKeys>,
  name: string,
  body: JsonRecord
) {
  return rpc(
    keys.supabaseUrl,
    keys.serviceRoleKey,
    keys.serviceRoleKey.startsWith('sb_secret_')
      ? null
      : keys.serviceRoleKey,
    name,
    body
  );
}

function rpcAsUser(
  keys: ReturnType<typeof configuredKeys>,
  accessToken: string,
  name: string,
  body: JsonRecord
) {
  return rpc(
    keys.supabaseUrl,
    keys.publishableKey,
    accessToken,
    name,
    body
  );
}

function bearerToken(request: Request) {
  const header = request.headers.get('authorization') || '';
  const matched = /^Bearer\s+(.+)$/i.exec(header);
  const token = matched?.[1]?.trim() || '';
  if (!token) throw new IntegrationError('authentication_required', 401);
  return token;
}

function authorizedConnectionId(value: Json) {
  const unwrapped = unwrapRpcValue(value);
  if (unwrapped === false) {
    throw new IntegrationError('woocommerce_action_not_authorized', 403);
  }
  const record = asRecord(unwrapped);
  if (!record) {
    throw new IntegrationError('woocommerce_connection_not_authorized', 403);
  }
  const explicitlyAuthorized = recordValue(
    record,
    'authorized',
    'isAuthorized',
    'is_authorized',
    'success'
  );
  if (explicitlyAuthorized === false) {
    throw new IntegrationError('woocommerce_action_not_authorized', 403);
  }
  const connectionId = recordText(
    record,
    'connectionId',
    'connection_id',
    'id'
  );
  if (!isUuid(connectionId)) {
    throw new IntegrationError('woocommerce_connection_not_found', 404);
  }
  return connectionId;
}

async function authorizeUserAction(
  request: Request,
  body: JsonRecord,
  keys: ReturnType<typeof configuredKeys>,
  action: 'test_connection' | 'sync_now'
) {
  const tenantSlug = recordText(body, 'tenantSlug', 'tenant_slug');
  if (
    tenantSlug.length < 2
    || tenantSlug.length > 100
    || !/^[a-z0-9][a-z0-9_-]*$/i.test(tenantSlug)
  ) {
    throw new IntegrationError('invalid_tenant_slug', 400);
  }
  const result = await rpcAsUser(
    keys,
    bearerToken(request),
    'v2_tenant_woocommerce_authorize',
    {
      p_tenant_slug: tenantSlug,
      p_action: action
    }
  );
  return authorizedConnectionId(result);
}

function ensureScheduleAuthorized(value: Json) {
  const unwrapped = unwrapRpcValue(value);
  if (unwrapped === false) {
    throw new IntegrationError('woocommerce_schedule_not_authorized', 401);
  }
  const record = asRecord(unwrapped);
  if (!record) return;
  const allowed = recordValue(
    record,
    'authorized',
    'isAuthorized',
    'is_authorized',
    'success'
  );
  if (allowed === false) {
    throw new IntegrationError('woocommerce_schedule_not_authorized', 401);
  }
}

function connectionConfiguration(value: Json): ConnectionConfiguration {
  const unwrapped = unwrapRpcValue(value);
  const record = asRecord(unwrapped);
  if (!record) {
    throw new IntegrationError('woocommerce_connection_not_configured', 409);
  }
  const configuration: ConnectionConfiguration = {
    connectionId: recordText(record, 'connectionId', 'connection_id'),
    tenantId: recordText(record, 'tenantId', 'tenant_id'),
    storeUrl: recordText(record, 'storeUrl', 'store_url'),
    consumerKey: recordText(record, 'consumerKey', 'consumer_key'),
    consumerSecret: recordText(record, 'consumerSecret', 'consumer_secret'),
    syncScope: (
      recordValue(record, 'syncScope', 'sync_scope') ?? null
    ) as Json,
    lastSyncedAt: recordText(record, 'lastSyncedAt', 'last_synced_at')
  };
  if (
    !isUuid(configuration.connectionId)
    || !isUuid(configuration.tenantId)
    || !configuration.storeUrl
    || !configuration.consumerKey
    || !configuration.consumerSecret
  ) {
    throw new IntegrationError('woocommerce_connection_incomplete', 409);
  }
  return configuration;
}

async function loadConnection(
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string
) {
  const value = await rpcAsService(
    keys,
    'v2_woocommerce_connection_configuration',
    {p_connection_id: connectionId}
  );
  const configuration = connectionConfiguration(value);
  if (configuration.connectionId !== connectionId) {
    throw new IntegrationError('woocommerce_connection_mismatch', 403);
  }
  return configuration;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const values = parts.map(part => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    return Number(part);
  });
  if (values.some(value => value < 0 || value > 255)) return null;
  return values;
}

function isPrivateIpv4(address: string) {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function embeddedIpv4FromIpv6(address: string) {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  if (dotted) return dotted;
  if (!normalized.startsWith('::ffff:')) return '';
  const hex = normalized.slice('::ffff:'.length).split(':');
  if (hex.length !== 2 || hex.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
    return '';
  }
  const high = Number.parseInt(hex[0], 16);
  const low = Number.parseInt(hex[1], 16);
  return [
    high >> 8,
    high & 255,
    low >> 8,
    low & 255
  ].join('.');
}

function isPrivateIpv6(address: string) {
  const normalized = address
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase();
  const embedded = embeddedIpv4FromIpv6(normalized);
  if (embedded) return isPrivateIpv4(embedded);
  const firstText = normalized.split(':')[0] || '0';
  const first = Number.parseInt(firstText, 16);
  return (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('2001:db8:')
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf)
    || (first >= 0xff00 && first <= 0xffff)
  );
}

function isIpAddress(hostname: string) {
  return Boolean(
    parseIpv4(hostname)
    || hostname.includes(':')
  );
}

function assertPublicHostname(hostname: string) {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !normalized
    || normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.home')
    || normalized.endsWith('.test')
    || normalized.endsWith('.invalid')
  ) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
  if (parseIpv4(normalized) && isPrivateIpv4(normalized)) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
  if (normalized.includes(':') && isPrivateIpv6(normalized)) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
  if (!isIpAddress(normalized) && !normalized.includes('.')) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
}

async function assertPublicDns(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  if (isIpAddress(normalized)) return;
  const [ipv4, ipv6] = await Promise.allSettled([
    Deno.resolveDns(normalized, 'A'),
    Deno.resolveDns(normalized, 'AAAA')
  ]);
  const addresses = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : [])
  ];
  if (!addresses.length) {
    throw new IntegrationError('woocommerce_store_dns_unavailable', 502);
  }
  if (
    addresses.some(address =>
      isPrivateIpv4(address) || isPrivateIpv6(address)
    )
  ) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
}

async function createWooClient(
  configuration: ConnectionConfiguration
): Promise<WooClient> {
  let storeUrl: URL;
  try {
    storeUrl = new URL(configuration.storeUrl);
  } catch {
    throw new IntegrationError('woocommerce_store_url_invalid', 400);
  }
  if (
    storeUrl.protocol !== 'https:'
    || storeUrl.username
    || storeUrl.password
    || (storeUrl.port && storeUrl.port !== '443')
  ) {
    throw new IntegrationError('woocommerce_store_url_not_public', 400);
  }
  assertPublicHostname(storeUrl.hostname);
  await assertPublicDns(storeUrl.hostname);

  storeUrl.hash = '';
  storeUrl.search = '';
  const cleanPath = storeUrl.pathname.replace(/\/+$/, '');
  const apiSuffix = '/wp-json/wc/v3';
  const apiPath = cleanPath.endsWith(apiSuffix)
    ? cleanPath
    : `${cleanPath}${apiSuffix}`;
  storeUrl.pathname = `${apiPath}/`;

  return {
    apiBase: storeUrl,
    authorization: `Basic ${btoa(
      `${configuration.consumerKey}:${configuration.consumerSecret}`
    )}`
  };
}

function endpointUrl(
  client: WooClient,
  endpoint: string,
  query: Record<string, string | number | undefined> = {}
) {
  const safeEndpoint = endpoint.replace(/^\/+/, '');
  const url = new URL(safeEndpoint, client.apiBase);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function validateNextUrl(client: WooClient, value: string) {
  let next: URL;
  try {
    next = new URL(value);
  } catch {
    throw new IntegrationError('woocommerce_pagination_url_invalid', 502);
  }
  if (
    next.protocol !== 'https:'
    || next.origin !== client.apiBase.origin
    || !next.pathname.startsWith(client.apiBase.pathname)
    || next.username
    || next.password
  ) {
    throw new IntegrationError('woocommerce_pagination_url_rejected', 502);
  }
  next.hash = '';
  next.searchParams.set('per_page', '100');
  return next;
}

function nextLink(headers: Headers) {
  const link = headers.get('link') || '';
  for (const part of link.split(',')) {
    if (/\brel="?next"?/i.test(part)) {
      return /<([^>]+)>/.exec(part)?.[1] || '';
    }
  }
  return '';
}

function retryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get('retry-after') || '';
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 10_000);
  }
  return Math.min(400 * (2 ** attempt), 4_000);
}

function wait(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  errorCode: string
) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new IntegrationError(errorCode, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function wooRequest(client: WooClient, url: URL): Promise<WooResponse> {
  for (let attempt = 0; attempt < MAX_REMOTE_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      await assertPublicDns(url.hostname);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: client.authorization,
          accept: 'application/json'
        },
        redirect: 'error',
        signal: controller.signal
      });
      if (
        RETRYABLE_STATUS.has(response.status)
        && attempt + 1 < MAX_REMOTE_ATTEMPTS
      ) {
        const delay = retryDelayMs(response, attempt);
        await response.body?.cancel();
        await wait(delay);
        continue;
      }
      const declaredLength = positiveInteger(
        response.headers.get('content-length')
      );
      if (
        declaredLength != null
        && declaredLength > MAX_REMOTE_RESPONSE_BYTES
      ) {
        await response.body?.cancel();
        throw new IntegrationError(
          'woocommerce_remote_response_too_large',
          502
        );
      }
      const payload = await readLimitedText(
        response.body,
        MAX_REMOTE_RESPONSE_BYTES,
        'woocommerce_remote_response_too_large'
      );
      if (!response.ok) {
        throw new IntegrationError(
          `woocommerce_remote_http_${response.status}`,
          response.status === 401 || response.status === 403 ? 400 : 502
        );
      }
      return {
        data: parseJsonSafely(payload),
        headers: response.headers
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (attempt + 1 >= MAX_REMOTE_ATTEMPTS) {
        throw new IntegrationError('woocommerce_remote_unavailable', 502);
      }
      await wait(Math.min(400 * (2 ** attempt), 4_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new IntegrationError('woocommerce_remote_unavailable', 502);
}

function entityToken(value: unknown): WooEntity | null {
  const token = textValue(value).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, WooEntity> = {
    categories: 'categories',
    category: 'categories',
    product_categories: 'categories',
    attributes: 'attributes',
    product_attributes: 'attributes',
    attribute_terms: 'attribute_terms',
    terms: 'attribute_terms',
    products: 'products',
    product: 'products',
    courses: 'products',
    variations: 'variations',
    product_variations: 'variations',
    coupons: 'coupons',
    offers: 'coupons',
    orders: 'orders',
    customers: 'customers'
  };
  return aliases[token] || null;
}

function scopeValues(value: Json): WooEntity[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value
      .map(entityToken)
      .filter((entity): entity is WooEntity => Boolean(entity));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return scopeValues(JSON.parse(trimmed) as Json);
      } catch {
        return [];
      }
    }
    return trimmed
      .split(',')
      .map(entityToken)
      .filter((entity): entity is WooEntity => Boolean(entity));
  }
  if (typeof value === 'object') {
    const record = value as JsonRecord;
    const nested = recordValue(
      record,
      'entities',
      'scope',
      'enabledEntities',
      'enabled_entities'
    );
    if (nested != null) return scopeValues(nested);
    return Object.entries(record)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => entityToken(key))
      .filter((entity): entity is WooEntity => Boolean(entity));
  }
  return [];
}

function selectedScope(configuration: Json, requested: Json | undefined) {
  const configured = scopeValues(configuration);
  const allowed = configured.length ? configured : ALL_ENTITIES;
  if (requested == null || requested === '') return [...allowed];
  const requestedEntities = scopeValues(requested);
  if (!requestedEntities.length) {
    throw new IntegrationError('woocommerce_sync_scope_invalid', 400);
  }
  const allowedSet = new Set(allowed);
  const selected = requestedEntities.filter(entity => allowedSet.has(entity));
  if (selected.length !== requestedEntities.length) {
    throw new IntegrationError('woocommerce_sync_scope_not_allowed', 403);
  }
  return [...new Set(selected)];
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    laquo: '«',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    raquo: '»',
    rdquo: '”',
    rsquo: '’'
  };
  return value.replace(
    /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith('#')) {
        const hexadecimal = entity[1]?.toLowerCase() === 'x';
        const code = Number.parseInt(
          entity.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10
        );
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      return named[entity.toLowerCase()] ?? match;
    }
  );
}

function plainText(value: unknown) {
  return decodeHtmlEntities(
    textValue(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function currencyMinorDigits(currency: string) {
  if (!currency) return 2;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function priceMinor(value: unknown, minorDigits: number) {
  const text = textValue(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * (10 ** minorDigits));
}

function simpleImage(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const src = recordText(record, 'src');
  if (!src) return null;
  return {
    id: positiveInteger(recordValue(record, 'id')),
    src,
    name: recordText(record, 'name'),
    alt: recordText(record, 'alt')
  };
}

function productAttributeMap(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const record = asRecord(item) || {};
    const options = Array.isArray(record.options)
      ? record.options.map(option => textValue(option)).filter(Boolean)
      : [];
    return {
      id: positiveInteger(record.id),
      name: recordText(record, 'name'),
      slug: recordText(record, 'slug'),
      option: recordText(record, 'option'),
      options
    };
  });
}

function matchingAttribute(
  attributes: ReturnType<typeof productAttributeMap>,
  patterns: RegExp[]
) {
  const matched = attributes.find(attribute => {
    const key = `${attribute.name} ${attribute.slug}`.toLowerCase();
    return patterns.some(pattern => pattern.test(key));
  });
  if (!matched) return '';
  return matched.option || matched.options.join(', ');
}

function normalizeProduct(
  item: JsonRecord,
  currency: string,
  parentProductId?: number
): JsonRecord {
  const minorDigits = currencyMinorDigits(currency);
  const categories = Array.isArray(item.categories)
    ? item.categories.map(category => asRecord(category)).filter(Boolean)
    : [];
  const images = Array.isArray(item.images)
    ? item.images.map(simpleImage).filter(Boolean)
    : [];
  const attributes = productAttributeMap(item.attributes);
  const primaryCategory = categories[0] || null;
  const deliveryMode = matchingAttribute(attributes, [
    /delivery/,
    /delivery.mode/,
    /training.mode/,
    /course.mode/,
    /طريقة/,
    /نمط/,
    /آلية/,
    /اسلوب/,
    /نوع.التدريب/
  ]);
  const duration = matchingAttribute(attributes, [
    /duration/,
    /course.length/,
    /training.hours/,
    /hours/,
    /مدة/,
    /ساع/
  ]);

  return {
    ...item,
    ...(parentProductId ? {parent_id: parentProductId} : {}),
    _marktone: {
      plainDescription: plainText(item.description),
      plainShortDescription: plainText(item.short_description),
      currency,
      currencyMinorDigits: minorDigits,
      priceMinor: priceMinor(item.price, minorDigits),
      regularPriceMinor: priceMinor(item.regular_price, minorDigits),
      salePriceMinor: priceMinor(item.sale_price, minorDigits),
      onSale: item.on_sale === true,
      primaryCategory: primaryCategory
        ? {
            id: positiveInteger(primaryCategory.id),
            name: recordText(primaryCategory, 'name'),
            slug: recordText(primaryCategory, 'slug')
          }
        : null,
      categoryIds: categories
        .map(category => positiveInteger(category?.id))
        .filter(id => id != null),
      categoryNames: categories
        .map(category => recordText(category || {}, 'name'))
        .filter(Boolean),
      image: images[0] || simpleImage(item.image),
      gallery: images.slice(1),
      imageUrl: recordText(images[0] || {}, 'src')
        || recordText(simpleImage(item.image) || {}, 'src'),
      galleryUrls: images
        .slice(1)
        .map(image => recordText(image || {}, 'src'))
        .filter(Boolean),
      status: recordText(item, 'status'),
      catalogVisibility: recordText(item, 'catalog_visibility'),
      purchasable: item.purchasable === true,
      stockStatus: recordText(item, 'stock_status'),
      deliveryMode,
      duration,
      attributes,
      parentProductId: parentProductId || null
    }
  };
}

function normalizeOrder(item: JsonRecord, fallbackCurrency: string): JsonRecord {
  const currency = recordText(item, 'currency').toUpperCase() || fallbackCurrency;
  const billing = asRecord(item.billing) || {};
  const customer = asRecord(item.customer) || {};
  return {
    ...item,
    _marktone: {
      externalId: recordText(item, 'id'),
      externalUpdatedAt: recordText(item, 'date_modified_gmt', 'date_modified'),
      orderNumber: recordText(item, 'number', 'id'),
      occurredAt: recordText(item, 'date_created_gmt', 'date_created'),
      status: recordText(item, 'status'),
      paymentStatus: recordText(item, 'status'),
      amountMinor: priceMinor(item.total, currencyMinorDigits(currency)),
      currency,
      customerId: recordText(item, 'customer_id') || recordText(customer, 'id'),
      customerEmail: recordText(billing, 'email') || recordText(customer, 'email'),
      customerPhone: recordText(billing, 'phone') || recordText(customer, 'phone'),
      ...orderAttribution(item)
    }
  };
}

function normalizeCustomer(item: JsonRecord): JsonRecord {
  const billing = asRecord(item.billing) || {};
  return {
    ...item,
    _marktone: {
      externalId: recordText(item, 'id'),
      externalUpdatedAt: recordText(item, 'date_modified_gmt', 'date_modified'),
      customerEmail: recordText(item, 'email') || recordText(billing, 'email'),
      customerPhone: recordText(billing, 'phone')
    }
  };
}

async function currentCurrency(client: WooClient) {
  const response = await wooRequest(
    client,
    endpointUrl(client, 'data/currencies/current')
  );
  const record = asRecord(response.data);
  const currency = recordText(record || {}, 'code').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new IntegrationError('woocommerce_currency_unavailable', 502);
  }
  return currency;
}

function pageInformation(
  headers: Headers,
  currentPage: number,
  itemCount: number
) {
  const totalPages = positiveInteger(headers.get('x-wp-totalpages'));
  const totalItems = positiveInteger(headers.get('x-wp-total'));
  const link = nextLink(headers);
  const hasMore = Boolean(link)
    || (totalPages != null && currentPage < totalPages)
    || (totalPages == null && !link && itemCount > 0);
  return {totalPages, totalItems, link, hasMore};
}

function jsonItems(value: Json) {
  if (!Array.isArray(value)) {
    throw new IntegrationError('woocommerce_remote_collection_invalid', 502);
  }
  return value.map(item => {
    const record = asRecord(item);
    if (!record) {
      throw new IntegrationError('woocommerce_remote_item_invalid', 502);
    }
    return record;
  });
}

async function storeBatch(
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string,
  runId: string,
  entityType: WooEntity,
  items: JsonRecord[],
  cursor: PageCursor,
  hasMore: boolean
) {
  await rpcAsService(keys, 'v2_woocommerce_store_batch', {
    p_connection_id: connectionId,
    p_run_id: runId,
    p_entity_type: entityType,
    p_items: items,
    p_cursor: cursor as unknown as JsonRecord,
    p_has_more: hasMore
  });
}

type PageWalkerOptions = {
  client: WooClient;
  endpoint: string;
  query?: Record<string, string | number | undefined>;
  entityType: WooEntity;
  parentId?: string | number;
  outerHasMore?: boolean;
  transform?: (item: JsonRecord) => JsonRecord;
  store?: boolean;
  onItems?: (items: JsonRecord[]) => void;
  keys: ReturnType<typeof configuredKeys>;
  connectionId: string;
  runId: string;
  stats: SyncStats;
};

async function walkPages(options: PageWalkerOptions) {
  let page = 1;
  let url = endpointUrl(options.client, options.endpoint, {
    ...options.query,
    page,
    per_page: 100
  });
  let foundItems = false;

  while (url) {
    const response = await wooRequest(options.client, url);
    const rawItems = jsonItems(response.data);
    const items = options.transform
      ? rawItems.map(options.transform)
      : rawItems;
    options.onItems?.(items);
    const pageInfo = pageInformation(
      response.headers,
      page,
      rawItems.length
    );
    const hasMore = pageInfo.hasMore || Boolean(options.outerHasMore);
    const cursor: PageCursor = {
      page,
      totalPages: pageInfo.totalPages,
      totalItems: pageInfo.totalItems,
      nextPage: pageInfo.hasMore ? page + 1 : null,
      ...(options.parentId != null ? {parentId: options.parentId} : {})
    };

    if (options.store !== false) {
      await storeBatch(
        options.keys,
        options.connectionId,
        options.runId,
        options.entityType,
        items,
        cursor,
        hasMore
      );
    }
    options.stats.totals[options.entityType] =
      (options.stats.totals[options.entityType] || 0) + items.length;
    options.stats.pages[options.entityType] =
      (options.stats.pages[options.entityType] || 0) + 1;
    foundItems ||= items.length > 0;

    if (!pageInfo.hasMore) break;
    if (page >= MAX_PAGES_PER_COLLECTION) {
      throw new IntegrationError(
        'woocommerce_collection_page_limit_reached',
        502
      );
    }
    page += 1;
    url = pageInfo.link
      ? validateNextUrl(options.client, pageInfo.link)
      : endpointUrl(options.client, options.endpoint, {
          ...options.query,
          page,
          per_page: 100
        });
  }
  return foundItems;
}

async function syncNestedCollection(
  options: {
    entityType: 'attribute_terms' | 'variations';
    parents: number[];
    endpoint: (parentId: number) => string;
    transform: (item: JsonRecord, parentId: number) => JsonRecord;
    client: WooClient;
    keys: ReturnType<typeof configuredKeys>;
    connectionId: string;
    runId: string;
    stats: SyncStats;
  }
) {
  if (!options.parents.length) {
    await storeBatch(
      options.keys,
      options.connectionId,
      options.runId,
      options.entityType,
      [],
      {page: 0, totalPages: 0, totalItems: 0, nextPage: null},
      false
    );
    options.stats.totals[options.entityType] = 0;
    options.stats.pages[options.entityType] = 1;
    return;
  }

  for (let index = 0; index < options.parents.length; index += 1) {
    const parentId = options.parents[index];
    await walkPages({
      client: options.client,
      endpoint: options.endpoint(parentId),
      entityType: options.entityType,
      parentId,
      outerHasMore: index < options.parents.length - 1,
      transform: item => options.transform(item, parentId),
      keys: options.keys,
      connectionId: options.connectionId,
      runId: options.runId,
      stats: options.stats
    });
  }
}

async function collectAttributeIds(
  client: WooClient,
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string,
  runId: string,
  stats: SyncStats,
  shouldStore: boolean
) {
  const ids: number[] = [];
  await walkPages({
    client,
    endpoint: 'products/attributes',
    entityType: 'attributes',
    store: shouldStore,
    onItems: items => {
      for (const item of items) {
        const id = positiveInteger(item.id);
        if (id != null) ids.push(id);
      }
    },
    keys,
    connectionId,
    runId,
    stats
  });
  if (!shouldStore) {
    delete stats.totals.attributes;
    delete stats.pages.attributes;
  }
  return [...new Set(ids)];
}

async function collectVariableProductIds(
  client: WooClient,
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string,
  runId: string,
  stats: SyncStats,
  shouldStore: boolean,
  currency: string
) {
  const ids: number[] = [];
  await walkPages({
    client,
    endpoint: 'products',
    query: shouldStore ? {} : {type: 'variable'},
    entityType: 'products',
    store: shouldStore,
    transform: item => normalizeProduct(item, currency),
    onItems: items => {
      for (const item of items) {
        const id = positiveInteger(item.id);
        const variations = Array.isArray(item.variations)
          ? item.variations
          : [];
        if (
          id != null
          && (
            recordText(item, 'type') === 'variable'
            || variations.length > 0
          )
        ) {
          ids.push(id);
        }
      }
    },
    keys,
    connectionId,
    runId,
    stats
  });
  if (!shouldStore) {
    delete stats.totals.products;
    delete stats.pages.products;
  }
  return [...new Set(ids)];
}

async function syncAllEntities(
  client: WooClient,
  keys: ReturnType<typeof configuredKeys>,
  configuration: ConnectionConfiguration,
  runId: string,
  scope: WooEntity[],
  stats: SyncStats
) {
  const selected = new Set(scope);
  const currency = await currentCurrency(client);
  const common = {
    client,
    keys,
    connectionId: configuration.connectionId,
    runId,
    stats
  };

  if (selected.has('categories')) {
    await walkPages({
      ...common,
      endpoint: 'products/categories',
      entityType: 'categories'
    });
  }

  let attributeIds: number[] = [];
  if (selected.has('attributes') || selected.has('attribute_terms')) {
    attributeIds = await collectAttributeIds(
      client,
      keys,
      configuration.connectionId,
      runId,
      stats,
      selected.has('attributes')
    );
  }
  if (selected.has('attribute_terms')) {
    await syncNestedCollection({
      ...common,
      entityType: 'attribute_terms',
      parents: attributeIds,
      endpoint: attributeId =>
        `products/attributes/${encodeURIComponent(attributeId)}/terms`,
      transform: (item, attributeId) => ({
        ...item,
        attribute_id: attributeId,
        _marktone: {attributeId}
      })
    });
  }

  let variableProductIds: number[] = [];
  if (selected.has('products') || selected.has('variations')) {
    variableProductIds = await collectVariableProductIds(
      client,
      keys,
      configuration.connectionId,
      runId,
      stats,
      selected.has('products'),
      currency
    );
  }
  if (selected.has('variations')) {
    await syncNestedCollection({
      ...common,
      entityType: 'variations',
      parents: variableProductIds,
      endpoint: productId =>
        `products/${encodeURIComponent(productId)}/variations`,
      transform: (item, productId) =>
        normalizeProduct(item, currency, productId)
    });
  }

  if (selected.has('coupons')) {
    await walkPages({
      ...common,
      endpoint: 'coupons',
      entityType: 'coupons'
    });
  }
  if (selected.has('orders')) {
    await walkPages({
      ...common,
      endpoint: 'orders',
      entityType: 'orders',
      transform: item => normalizeOrder(item, currency)
    });
  }
  if (selected.has('customers')) {
    await walkPages({
      ...common,
      endpoint: 'customers',
      entityType: 'customers',
      transform: normalizeCustomer
    });
  }

  return {
    apiVersion: 'wc/v3',
    storeOrigin: client.apiBase.origin,
    currency: currency || null,
    lastSyncedAt: configuration.lastSyncedAt || null
  } as JsonRecord;
}

function startResult(value: Json) {
  const unwrapped = unwrapRpcValue(value);
  const record = asRecord(unwrapped);
  if (!record) throw new IntegrationError('woocommerce_sync_start_failed', 500);
  const runId = recordText(record, 'runId', 'run_id');
  if (!isUuid(runId)) {
    throw new IntegrationError('woocommerce_sync_run_invalid', 500);
  }
  return {
    runId,
    duplicate:
      recordValue(record, 'duplicate', 'isDuplicate', 'is_duplicate') === true,
    status: recordText(record, 'status') || 'running'
  };
}

function safeErrorCode(error: unknown) {
  if (error instanceof IntegrationError) return error.code.slice(0, 160);
  return 'woocommerce_sync_failed';
}

function errorStatus(error: unknown) {
  if (error instanceof IntegrationError) return error.status;
  return 500;
}

function idempotencyKey(
  request: Request | null,
  body: JsonRecord,
  connectionId: string,
  trigger: 'manual' | 'scheduled'
) {
  const supplied = (
    request?.headers.get('x-idempotency-key')
    || recordText(body, 'idempotencyKey', 'idempotency_key')
  ).trim();
  if (supplied) {
    if (supplied.length < 8 || supplied.length > 180) {
      throw new IntegrationError('invalid_idempotency_key', 400);
    }
    return supplied;
  }
  if (trigger === 'scheduled') {
    return [
      'woocommerce',
      'scheduled',
      connectionId,
      new Date().toISOString().slice(0, 13)
    ].join(':');
  }
  return `woocommerce:manual:${connectionId}:${crypto.randomUUID()}`;
}

async function performSync(
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string,
  trigger: 'manual' | 'scheduled',
  requestedScope: Json | undefined,
  request: Request | null,
  body: JsonRecord
): Promise<JsonRecord> {
  const configuration = await loadConnection(keys, connectionId);
  const scope = selectedScope(configuration.syncScope, requestedScope);
  const start = startResult(
    await rpcAsService(keys, 'v2_woocommerce_start_sync', {
      p_connection_id: connectionId,
      p_trigger: trigger,
      p_scope: scope,
      p_idempotency_key: idempotencyKey(
        request,
        body,
        connectionId,
        trigger
      )
    })
  );

  if (start.duplicate) {
    if (start.status === 'running') {
      throw new IntegrationError('woocommerce_sync_in_progress', 409);
    }
    if (start.status === 'failed') {
      throw new IntegrationError('woocommerce_previous_sync_failed', 409);
    }
    return {
      success: true,
      connectionId,
      runId: start.runId,
      duplicate: true,
      status: start.status
    };
  }

  const stats: SyncStats = {
    startedAt: new Date().toISOString(),
    scope,
    totals: {},
    pages: {}
  };

  try {
    const client = await createWooClient(configuration);
    const remoteMetadata = await syncAllEntities(
      client,
      keys,
      configuration,
      start.runId,
      scope,
      stats
    );
    stats.completedAt = new Date().toISOString();
    stats.durationMs =
      Date.parse(stats.completedAt) - Date.parse(stats.startedAt);
    await rpcAsService(keys, 'v2_woocommerce_complete_sync', {
      p_connection_id: connectionId,
      p_run_id: start.runId,
      p_stats: stats as unknown as JsonRecord,
      p_remote_metadata: remoteMetadata
    });
    return {
      success: true,
      connectionId,
      runId: start.runId,
      duplicate: false,
      status: 'completed',
      stats: stats as unknown as JsonRecord,
      remoteMetadata
    };
  } catch (error) {
    try {
      await rpcAsService(keys, 'v2_woocommerce_fail_sync', {
        p_connection_id: connectionId,
        p_run_id: start.runId,
        p_error: safeErrorCode(error)
      });
    } catch {
      // Preserve the original, sanitized sync failure.
    }
    throw error;
  }
}

async function testConnection(
  keys: ReturnType<typeof configuredKeys>,
  connectionId: string
) {
  let metadata: JsonRecord = {};
  try {
    const configuration = await loadConnection(keys, connectionId);
    const client = await createWooClient(configuration);
    const response = await wooRequest(
      client,
      endpointUrl(client, 'products', {page: 1, per_page: 1})
    );
    jsonItems(response.data);
    const currency = await currentCurrency(client);
    metadata = {
      apiVersion: 'wc/v3',
      storeOrigin: client.apiBase.origin,
      currency: currency || null,
      totalProducts: positiveInteger(response.headers.get('x-wp-total')),
      totalProductPages: positiveInteger(
        response.headers.get('x-wp-totalpages')
      ),
      testedAt: new Date().toISOString()
    };
    await rpcAsService(keys, 'v2_woocommerce_test_complete', {
      p_connection_id: connectionId,
      p_success: true,
      p_remote_metadata: metadata,
      p_error: null
    });
    return {
      success: true,
      connectionId,
      remoteMetadata: metadata
    } as JsonRecord;
  } catch (error) {
    const code = safeErrorCode(error);
    try {
      await rpcAsService(keys, 'v2_woocommerce_test_complete', {
        p_connection_id: connectionId,
        p_success: false,
        p_remote_metadata: metadata,
        p_error: code
      });
    } catch {
      // Preserve the original, sanitized test failure.
    }
    throw error;
  }
}

function dueConnectionIds(value: Json) {
  const unwrapped = value == null ? [] : value;
  const items = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
  const ids: string[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const connectionId = recordText(
      record,
      'connectionId',
      'connection_id',
      'id'
    );
    if (isUuid(connectionId)) ids.push(connectionId);
  }
  return [...new Set(ids)];
}

async function scheduledSync(
  request: Request,
  body: JsonRecord,
  keys: ReturnType<typeof configuredKeys>
) {
  const secret = (
    request.headers.get('x-marktone-woocommerce-secret') || ''
  ).trim();
  if (!secret || secret.length > 4096) {
    throw new IntegrationError('woocommerce_schedule_not_authorized', 401);
  }
  ensureScheduleAuthorized(
    await rpcAsService(keys, 'v2_woocommerce_schedule_authorize', {
      p_secret: secret
    })
  );
  const connectionIds = dueConnectionIds(
    await rpcAsService(keys, 'v2_woocommerce_due_connections', {})
  );
  const results: JsonRecord[] = [];
  for (const connectionId of connectionIds) {
    try {
      results.push(
        await performSync(
          keys,
          connectionId,
          'scheduled',
          undefined,
          null,
          body
        )
      );
    } catch (error) {
      results.push({
        success: false,
        connectionId,
        error: safeErrorCode(error)
      });
    }
  }
  return {
    success: results.every(result => result.success === true),
    processed: results.length,
    results
  } as JsonRecord;
}

async function requestBody(request: Request): Promise<JsonRecord> {
  const declaredLength = positiveInteger(
    request.headers.get('content-length')
  );
  if (declaredLength != null && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new IntegrationError('request_body_too_large', 413);
  }
  let parsed: unknown;
  try {
    const text = await readLimitedText(
      request.body,
      MAX_REQUEST_BODY_BYTES,
      'request_body_too_large'
    );
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrationError('invalid_request_body', 400);
  }
  const body = asRecord(parsed);
  if (!body) throw new IntegrationError('invalid_request_body', 400);
  return body;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {status: 204, headers: corsHeaders});
  }
  if (request.method !== 'POST') {
    return json({error: 'method_not_allowed'}, 405);
  }

  try {
    const keys = configuredKeys();
    if (
      !keys.supabaseUrl
      || !keys.publishableKey
      || !keys.serviceRoleKey
    ) {
      return json({error: 'server_not_configured'}, 503);
    }
    const body = await requestBody(request);
    const action = recordText(body, 'action');

    if (action === 'test_connection') {
      const connectionId = await authorizeUserAction(
        request,
        body,
        keys,
        action
      );
      return json(await testConnection(keys, connectionId));
    }

    if (action === 'sync_now') {
      const connectionId = await authorizeUserAction(
        request,
        body,
        keys,
        action
      );
      const requestedScope = recordValue(body, 'scope', 'syncScope');
      return json(
        await performSync(
          keys,
          connectionId,
          'manual',
          requestedScope === null ? undefined : requestedScope,
          request,
          body
        )
      );
    }

    if (action === 'scheduled_sync') {
      return json(await scheduledSync(request, body, keys));
    }

    return json({error: 'unsupported_action'}, 400);
  } catch (error) {
    return json(
      {error: safeErrorCode(error)},
      errorStatus(error)
    );
  }
});
