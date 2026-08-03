import type {
  CommerceEntity,
  ConnectionConfiguration,
  EntityPage,
  Json,
  JsonRecord
} from './types.ts';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 24_000;
const MAX_PAGES = 300;

export class CommerceError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 500) {
    super(code);
    this.name = 'CommerceError';
    this.code = code;
    this.status = status;
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value as Json[] : [];
}

export function text(value: unknown) {
  return value == null ? '' : String(value).trim();
}

export function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function moneyMinor(value: unknown, digits = 2): number | null {
  const parsed = numberValue(value);
  if (parsed == null || parsed < 0) return null;
  const factor = 10 ** Math.min(Math.max(digits, 0), 4);
  return Math.round(parsed * factor);
}

export function valueAt(record: JsonRecord, ...paths: string[]): Json {
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

export function listAt(record: JsonRecord, ...paths: string[]): Json[] {
  const value = valueAt(record, ...paths);
  return asArray(value);
}

export function externalItem(item: JsonRecord, externalId: unknown): JsonRecord {
  return {
    ...item,
    _marktone: {
      externalId: text(externalId)
    }
  };
}

export function normalizedProduct(
  item: JsonRecord,
  normalized: JsonRecord
): JsonRecord {
  return {
    ...item,
    _marktone: normalized
  };
}

export function normalizedEntity(
  item: JsonRecord,
  normalized: JsonRecord
): JsonRecord {
  return {
    ...item,
    _marktone: normalized
  };
}

function metadataMap(item: JsonRecord) {
  const result: Record<string, Json> = {};
  for (const path of [
    'meta_data',
    'metadata',
    'custom_attributes',
    'customAttributes',
    'note_attributes',
    'noteAttributes'
  ]) {
    const value = valueAt(item, path);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const record = asRecord(entry);
        if (!record) continue;
        const key = text(valueAt(record, 'key', 'name', 'attribute'));
        if (key) result[key] = valueAt(record, 'value', 'text');
      }
    } else {
      const record = asRecord(value);
      if (record) Object.assign(result, record);
    }
  }
  return result;
}

function trackedValue(item: JsonRecord, metadata: Record<string, Json>, ...keys: string[]) {
  for (const key of keys) {
    const value = valueAt(
      item,
      key,
      `tracking.${key}`,
      `attribution.${key}`,
      `marketing.${key}`
    );
    if (text(value)) return text(value);
    for (const alias of [key, key.toLowerCase(), key.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)]) {
      if (text(metadata[alias])) return text(metadata[alias]);
    }
  }
  return '';
}

export function attributionFields(item: JsonRecord): JsonRecord {
  const metadata = metadataMap(item);
  const clickEntries = [
    ['gclid', trackedValue(item, metadata, 'gclid')],
    ['gbraid', trackedValue(item, metadata, 'gbraid')],
    ['wbraid', trackedValue(item, metadata, 'wbraid')],
    ['fbclid', trackedValue(item, metadata, 'fbclid', 'fbc')],
    ['ttclid', trackedValue(item, metadata, 'ttclid')],
    ['sc_click_id', trackedValue(item, metadata, 'sc_click_id', 'scClickId')]
  ].filter(([, value]) => Boolean(value));
  const [clickIdType, clickId] = clickEntries[0] || ['', ''];
  return {
    source: trackedValue(item, metadata, 'source', 'sourceName'),
    clickIdType,
    clickId,
    utmSource: trackedValue(item, metadata, 'utm_source', 'utmSource'),
    utmMedium: trackedValue(item, metadata, 'utm_medium', 'utmMedium'),
    utmCampaign: trackedValue(item, metadata, 'utm_campaign', 'utmCampaign'),
    utmContent: trackedValue(item, metadata, 'utm_content', 'utmContent'),
    utmTerm: trackedValue(item, metadata, 'utm_term', 'utmTerm'),
    externalCampaignId: trackedValue(
      item,
      metadata,
      'external_campaign_id',
      'campaign_id',
      'campaignId'
    ),
    externalAdGroupId: trackedValue(
      item,
      metadata,
      'external_ad_group_id',
      'adset_id',
      'ad_group_id',
      'adGroupId'
    ),
    externalAdId: trackedValue(
      item,
      metadata,
      'external_ad_id',
      'ad_id',
      'adId'
    ),
    landingUrl: trackedValue(
      item,
      metadata,
      'landing_url',
      'landingPageUrl',
      'landingPage'
    ),
    referrerUrl: trackedValue(
      item,
      metadata,
      'referrer_url',
      'referringSite',
      'referrerUrl'
    )
  };
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get('retry-after');
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 8_000);
  }
  return Math.min(350 * 2 ** attempt + Math.floor(Math.random() * 180), 5_000);
}

async function readResponse(response: Response): Promise<Json> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) {
    throw new CommerceError('remote_response_too_large', 502);
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new CommerceError('remote_response_too_large', 502);
  }
  if (!body) return null;
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new CommerceError('remote_invalid_json', 502);
  }
}

export async function remoteJson(
  url: string | URL,
  init: RequestInit = {}
): Promise<{data: Json; headers: Headers}> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'Marktone-Commerce-Hub/1.0',
          ...(init.headers || {})
        }
      });
      lastResponse = response;
      if (response.ok) {
        return {data: await readResponse(response), headers: response.headers};
      }
      if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
        const payload = await readResponse(response).catch(() => null);
        const detail = text(valueAt(asRecord(payload) || {}, 'message', 'error', 'detail'));
        throw new CommerceError(
          `remote_http_${response.status}${detail ? `:${detail.slice(0, 180)}` : ''}`,
          response.status === 401 || response.status === 403 ? 400 : 502
        );
      }
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new CommerceError(
          error instanceof DOMException && error.name === 'AbortError'
            ? 'remote_timeout'
            : 'remote_network_error',
          502
        );
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, retryDelay(lastResponse, attempt)));
  }
  throw new CommerceError('remote_request_failed', 502);
}

export function itemsFrom(payload: Json, entity: CommerceEntity): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter(Boolean) as JsonRecord[];
  const record = asRecord(payload);
  if (!record) return [];
  const candidates = [
    record.data,
    record.results,
    record.items,
    record[entity],
    entity === 'products' ? record.products : null,
    entity === 'categories' ? record.categories : null,
    entity === 'collections' ? record.collections : null,
    entity === 'coupons' ? record.coupons : null,
    entity === 'orders' ? record.orders : null,
    entity === 'customers' ? record.customers : null
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(asRecord).filter(Boolean) as JsonRecord[];
    }
  }
  return [];
}

export function assertPageLimit(page: number) {
  if (page > MAX_PAGES) throw new CommerceError('remote_pagination_limit', 502);
}

export function withQuery(url: string | URL, values: Record<string, string | number | null>) {
  const result = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '') result.searchParams.set(key, String(value));
  }
  return result;
}

export function productIdentity(item: JsonRecord) {
  return text(valueAt(item, 'id', 'uuid', 'admin_graphql_api_id'));
}

export function pageResult(items: JsonRecord[], page: number, hasMore: boolean): EntityPage {
  return {items, cursor: {page}, hasMore};
}

export function configuration(record: ConnectionConfiguration, key: string) {
  return text(record.configuration[key]);
}

export function secret(record: ConnectionConfiguration, key: string) {
  return text(record.secrets[key]);
}

export function stripHtml(value: unknown) {
  return text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function compact<T>(values: (T | null | undefined | '')[]) {
  return values.filter(Boolean) as T[];
}
