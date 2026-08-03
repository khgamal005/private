import type {
  Json,
  JsonRecord,
  MarketingConnection
} from './types.ts';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_RESPONSE_BYTES = 18 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 28_000;

export class AdsSyncError extends Error {
  code: string;
  status: number;
  detail: string;

  constructor(code: string, status = 500, detail = '') {
    super(code);
    this.name = 'AdsSyncError';
    this.code = code;
    this.status = status;
    this.detail = detail;
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

export function valueAt(record: JsonRecord, ...paths: string[]): Json {
  for (const path of paths) {
    let current: Json = record;
    let found = true;
    for (const part of path.split('.')) {
      if (Array.isArray(current)) {
        const index = /^\d+$/.test(part) ? Number(part) : -1;
        if (index < 0 || index >= current.length) {
          found = false;
          break;
        }
        current = current[index];
        continue;
      }
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

export function configuration(connection: MarketingConnection, key: string) {
  return text(connection.configuration[key]);
}

export function secret(connection: MarketingConnection, key: string) {
  return text(connection.secrets[key]);
}

export function currencyDigits(currency: string) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || 'USD'
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function moneyMinor(value: unknown, currency = 'USD'): number {
  const parsed = numberValue(value);
  if (parsed == null || parsed < 0) return 0;
  return Math.round(parsed * (10 ** currencyDigits(currency)));
}

export function microsToMinor(value: unknown, currency = 'USD'): number {
  const parsed = numberValue(value);
  if (parsed == null || parsed < 0) return 0;
  return Math.round(parsed / (10 ** (6 - currencyDigits(currency))));
}

export function batches<T>(items: T[], size = 450): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function queryUrl(
  base: string | URL,
  values: Record<string, string | number | boolean | null | undefined>
) {
  const result = new URL(base);
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '') result.searchParams.set(key, String(value));
  }
  return result;
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = Number(response?.headers.get('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(450 * 2 ** attempt + Math.floor(Math.random() * 250), 6_000);
}

async function responseJson(response: Response): Promise<Json> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new AdsSyncError('remote_response_too_large', 502);
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new AdsSyncError('remote_response_too_large', 502);
  }
  if (!body) return null;
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new AdsSyncError('remote_invalid_json', 502);
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
          'user-agent': 'Marktone-Marketing-Hub/1.0',
          ...(init.headers || {})
        }
      });
      lastResponse = response;
      const data = await responseJson(response);
      if (response.ok) return {data, headers: response.headers};

      const detail = text(valueAt(
        asRecord(data) || {},
        'error.message',
        'error.details.0.message',
        'message',
        'detail'
      )).slice(0, 320);
      if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
        throw new AdsSyncError(
          `remote_http_${response.status}`,
          response.status === 401 || response.status === 403 ? 400 : 502,
          detail
        );
      }
    } catch (error) {
      if (error instanceof AdsSyncError) throw error;
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new AdsSyncError(
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
  throw new AdsSyncError('remote_request_failed', 502);
}

export async function oauthToken(
  url: string,
  values: Record<string, string>
) {
  const {data} = await remoteJson(url, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(values).toString()
  });
  const record = asRecord(data) || {};
  const accessToken = text(record.access_token);
  if (!accessToken) {
    throw new AdsSyncError('oauth_refresh_failed', 400, text(record.error_description));
  }
  return {
    accessToken,
    expiresIn: numberValue(record.expires_in),
    refreshToken: text(record.refresh_token)
  };
}

export function sumAction(
  value: Json,
  exact: string[],
  contains: string[] = []
) {
  return asArray(value).reduce((total, entry) => {
    const record = asRecord(entry) || {};
    const actionType = text(record.action_type).toLowerCase();
    if (
      exact.includes(actionType)
      || contains.some(pattern => actionType.includes(pattern))
    ) {
      return total + (numberValue(record.value) || 0);
    }
    return total;
  }, 0);
}

export function utmFields(urlValue: unknown) {
  const value = text(urlValue);
  if (!value) return {};
  try {
    const parsed = new URL(value);
    return {
      destinationUrl: parsed.origin + parsed.pathname,
      utmSource: parsed.searchParams.get('utm_source') || '',
      utmMedium: parsed.searchParams.get('utm_medium') || '',
      utmCampaign: parsed.searchParams.get('utm_campaign') || '',
      utmContent: parsed.searchParams.get('utm_content') || ''
    };
  } catch {
    return {};
  }
}
