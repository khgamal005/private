import type {
  AccountIdentity,
  Json,
  JsonRecord,
  MarketingAdapter,
  MarketingConnection,
  MarketingProvider,
  SyncRange
} from './types.ts';
import {AdsSyncError, asRecord, text, valueAt} from './shared.ts';
import {metaAdapter} from './adapters/meta.ts';
import {googleAdapter} from './adapters/google.ts';
import {tiktokAdapter} from './adapters/tiktok.ts';
import {snapchatAdapter} from './adapters/snapchat.ts';

const MAX_BODY_BYTES = 64 * 1024;
const PROVIDERS = new Set<MarketingProvider>([
  'meta',
  'google_ads',
  'tiktok_ads',
  'snapchat_ads'
]);
const USER_ACTIONS = new Set(['test_connection', 'sync_now']);

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': [
    'authorization',
    'apikey',
    'content-type',
    'x-idempotency-key',
    'x-marktone-marketing-secret'
  ].join(', '),
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
  vary: 'Origin'
};
const jsonHeaders = {
  ...corsHeaders,
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0'
};

class RpcError extends AdsSyncError {
  constructor(name: string, status: number, detail = '') {
    super(
      `marketing_rpc_${name}_${status}`,
      status === 401 || status === 403 ? status : 500,
      detail
    );
    this.name = 'RpcError';
  }
}

function env(name: string) {
  return Deno.env.get(name)?.trim() || '';
}

function dictionaryKey(name: string) {
  const raw = env(name);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return text(Object.values(parsed)[0]);
  } catch {
    return '';
  }
}

function configuredKeys() {
  return {
    url: env('SUPABASE_URL'),
    publishable:
      env('SUPABASE_ANON_KEY')
      || env('SUPABASE_PUBLISHABLE_KEY')
      || dictionaryKey('SUPABASE_PUBLISHABLE_KEYS'),
    service:
      env('SUPABASE_SERVICE_ROLE_KEY')
      || env('SUPABASE_SECRET_KEY')
      || dictionaryKey('SUPABASE_SECRET_KEYS')
  };
}

function json(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: jsonHeaders});
}

async function rpc(
  apiUrl: string,
  apiKey: string,
  bearer: string | null,
  name: string,
  body: JsonRecord
): Promise<Json> {
  const headers: Record<string, string> = {
    apikey: apiKey,
    accept: 'application/json',
    'content-type': 'application/json'
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${apiUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error'
  });
  const raw = await response.text();
  let payload: Json = null;
  if (raw) {
    try { payload = JSON.parse(raw) as Json; } catch { payload = raw; }
  }
  if (!response.ok) {
    const detail = text(valueAt(
      asRecord(payload) || {},
      'message',
      'hint',
      'details'
    )).slice(0, 320);
    throw new RpcError(name, response.status, detail);
  }
  return payload;
}

function rpcUser(
  config: ReturnType<typeof configuredKeys>,
  token: string,
  name: string,
  body: JsonRecord
) {
  return rpc(config.url, config.publishable, token, name, body);
}

function rpcService(
  config: ReturnType<typeof configuredKeys>,
  name: string,
  body: JsonRecord
) {
  return rpc(
    config.url,
    config.service,
    config.service.startsWith('sb_secret_') ? null : config.service,
    name,
    body
  );
}

function bearer(request: Request) {
  const value = request.headers.get('authorization') || '';
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

async function requestBody(request: Request): Promise<JsonRecord> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new AdsSyncError('request_too_large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new AdsSyncError('request_too_large', 413);
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    const record = asRecord(parsed);
    if (!record) throw new Error('not_object');
    return record;
  } catch {
    throw new AdsSyncError('invalid_request_json', 400);
  }
}

function connection(value: Json): MarketingConnection {
  const record = asRecord(value);
  if (
    !record
    || !text(record.connectionId)
    || !PROVIDERS.has(text(record.providerKey) as MarketingProvider)
  ) {
    throw new AdsSyncError('marketing_configuration_invalid', 500);
  }
  return record as unknown as MarketingConnection;
}

function adapter(provider: MarketingProvider): MarketingAdapter {
  if (provider === 'meta') return metaAdapter;
  if (provider === 'google_ads') return googleAdapter;
  if (provider === 'tiktok_ads') return tiktokAdapter;
  if (provider === 'snapchat_ads') return snapchatAdapter;
  throw new AdsSyncError('marketing_provider_not_supported', 400);
}

function dateOnly(value: unknown) {
  const result = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : '';
}

function defaultRange(connectionValue: MarketingConnection): SyncRange {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo);
  const lookback = Math.max(1, Math.min(Number(connectionValue.syncLookbackDays) || 14, 90));
  dateFrom.setUTCDate(dateFrom.getUTCDate() - lookback + 1);
  return {
    dateFrom: dateFrom.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10)
  };
}

function requestedRange(
  payload: JsonRecord,
  connectionValue: MarketingConnection
): SyncRange {
  const defaults = defaultRange(connectionValue);
  const dateFrom = dateOnly(payload.dateFrom) || defaults.dateFrom;
  const dateTo = dateOnly(payload.dateTo) || defaults.dateTo;
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0 || days > 92) {
    throw new AdsSyncError('marketing_sync_range_invalid', 400);
  }
  return {dateFrom, dateTo};
}

function errorInfo(error: unknown) {
  if (error instanceof AdsSyncError) {
    return {
      code: error.code.slice(0, 160),
      detail: (error.detail || error.message).slice(0, 1000)
    };
  }
  return {
    code: 'marketing_sync_failed',
    detail: (error instanceof Error ? error.message : 'unknown_error').slice(0, 1000)
  };
}

async function completeTest(
  config: ReturnType<typeof configuredKeys>,
  connectionValue: MarketingConnection,
  selected: MarketingAdapter
) {
  try {
    const identity = await selected.test(connectionValue);
    await rpcService(config, 'v2_marketing_hub_finish_test', {
      p_connection_id: connectionValue.connectionId,
      p_success: true,
      p_identity: identity,
      p_error_code: null,
      p_error_detail: null
    });
    return identity;
  } catch (error) {
    const info = errorInfo(error);
    await rpcService(config, 'v2_marketing_hub_finish_test', {
      p_connection_id: connectionValue.connectionId,
      p_success: false,
      p_identity: {},
      p_error_code: info.code,
      p_error_detail: info.detail
    }).catch(() => null);
    throw error;
  }
}

async function synchronize(
  config: ReturnType<typeof configuredKeys>,
  connectionValue: MarketingConnection,
  selected: MarketingAdapter,
  account: AccountIdentity,
  range: SyncRange,
  trigger: 'manual' | 'scheduled' | 'recovery',
  idempotencyKey: string
) {
  const started = asRecord(await rpcService(config, 'v2_marketing_hub_start_sync', {
    p_connection_id: connectionValue.connectionId,
    p_trigger: trigger,
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
    p_idempotency_key: idempotencyKey.slice(0, 200)
  }));
  const runId = text(started?.runId);
  if (!runId) throw new AdsSyncError('marketing_run_start_failed', 500);
  if (Boolean(started?.duplicate)) {
    return {success: true, duplicate: true, runId, status: text(started?.status)};
  }

  const stats = {
    dimensionPages: 0,
    metricPages: 0,
    campaigns: 0,
    adGroups: 0,
    ads: 0,
    metrics: 0,
    failedRows: 0,
    attribution: {} as JsonRecord
  };
  try {
    for await (const page of selected.dimensions(connectionValue, account)) {
      const stored = asRecord(await rpcService(
        config,
        'v2_marketing_hub_store_dimensions',
        {
          p_connection_id: connectionValue.connectionId,
          p_run_id: runId,
          p_payload: page
        }
      )) || {};
      stats.dimensionPages += 1;
      stats.campaigns += Number(stored.campaignCount || 0);
      stats.adGroups += Number(stored.adGroupCount || 0);
      stats.ads += Number(stored.adCount || 0);
      stats.failedRows += Number(stored.failedCount || 0);
    }

    for await (const page of selected.metrics(connectionValue, account, range)) {
      const stored = asRecord(await rpcService(config, 'v2_marketing_hub_store_metrics', {
        p_connection_id: connectionValue.connectionId,
        p_run_id: runId,
        p_metrics: page.metrics,
        p_cursor: page.cursor || {}
      })) || {};
      stats.metricPages += 1;
      stats.metrics += Number(stored.storedCount || 0);
      stats.failedRows += Number(stored.failedCount || 0);
    }

    try {
      stats.attribution = asRecord(await rpcService(
        config,
        'v2_marketing_hub_refresh_attribution',
        {
          p_tenant_id: connectionValue.tenantId,
          p_date_from: range.dateFrom,
          p_date_to: range.dateTo
        }
      )) || {};
    } catch (error) {
      const info = errorInfo(error);
      stats.attribution = {error: info.code, detail: info.detail};
      stats.failedRows += 1;
    }

    const status = stats.failedRows > 0 ? 'partial' : 'success';
    const finished = await rpcService(config, 'v2_marketing_hub_finish_sync', {
      p_connection_id: connectionValue.connectionId,
      p_run_id: runId,
      p_status: status,
      p_stats: stats,
      p_error_code: status === 'partial' ? 'marketing_partial_sync' : null,
      p_error_detail: status === 'partial'
        ? `${stats.failedRows} rows or post-processing steps failed`
        : null,
      p_remote_metadata: {
        account,
        apiVersion: connectionValue.apiVersion,
        range
      }
    });
    return {success: true, duplicate: false, runId, status, stats, finished};
  } catch (error) {
    const info = errorInfo(error);
    await rpcService(config, 'v2_marketing_hub_finish_sync', {
      p_connection_id: connectionValue.connectionId,
      p_run_id: runId,
      p_status: 'failed',
      p_stats: stats,
      p_error_code: info.code,
      p_error_detail: info.detail,
      p_remote_metadata: {account, apiVersion: connectionValue.apiVersion, range}
    }).catch(() => null);
    throw error;
  }
}

async function connectionConfiguration(
  config: ReturnType<typeof configuredKeys>,
  connectionId: string
) {
  return connection(await rpcService(
    config,
    'v2_marketing_hub_connection_configuration',
    {p_connection_id: connectionId}
  ));
}

async function dispatchDue(
  config: ReturnType<typeof configuredKeys>,
  payload: JsonRecord
) {
  const requestedLimit = Math.max(1, Math.min(Number(payload.limit) || 2, 3));
  const due = await rpcService(config, 'v2_marketing_hub_claim_due_connections', {
    p_limit: requestedLimit,
    p_worker_id: `edge:${crypto.randomUUID()}`
  });
  const rows = Array.isArray(due) ? due : [];
  const results: Json[] = [];
  for (const rowValue of rows) {
    const row = asRecord(rowValue) || {};
    const connectionId = text(row.connectionId);
    try {
      const current = await connectionConfiguration(config, connectionId);
      const selected = adapter(current.providerKey);
      const account = await completeTest(config, current, selected);
      const range = defaultRange(current);
      results.push(await synchronize(
        config,
        current,
        selected,
        account,
        range,
        'scheduled',
        `scheduled:${connectionId}:${range.dateFrom}:${range.dateTo}:${crypto.randomUUID()}`
      ) as unknown as Json);
    } catch (error) {
      results.push({connectionId, ...errorInfo(error)});
    }
  }
  return {success: true, claimed: rows.length, results};
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});
  if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);

  try {
    const config = configuredKeys();
    if (!config.url || !config.publishable || !config.service) {
      throw new AdsSyncError('supabase_environment_missing', 500);
    }
    const payload = await requestBody(request);
    const action = text(payload.action).toLowerCase();
    if (action === 'dispatch_due') {
      const supplied = text(request.headers.get('x-marktone-marketing-secret'));
      if (!supplied || supplied.length > 4096) {
        throw new AdsSyncError('marketing_schedule_not_authorized', 401);
      }
      const authorized = await rpcService(
        config,
        'v2_marketing_schedule_authorize',
        {p_secret: supplied}
      );
      if (authorized !== true) {
        throw new AdsSyncError('marketing_schedule_not_authorized', 401);
      }
      return json(await dispatchDue(config, payload) as unknown as JsonRecord);
    }

    const token = bearer(request);
    if (!token) throw new AdsSyncError('authentication_required', 401);
    const tenantSlug = text(payload.tenantSlug);
    const provider = text(payload.provider).toLowerCase() as MarketingProvider;
    if (!tenantSlug || !PROVIDERS.has(provider) || !USER_ACTIONS.has(action)) {
      throw new AdsSyncError('invalid_marketing_request', 400);
    }

    const authorized = asRecord(await rpcUser(
      config,
      token,
      text(payload.source) === 'social_connect' && provider === 'meta'
        ? 'v1_tenant_meta_connect_v2_authorize_sync'
        : 'v2_marketing_hub_authorize',
      text(payload.source) === 'social_connect' && provider === 'meta'
        ? {p_tenant_slug: tenantSlug, p_action: action}
        : {p_tenant_slug: tenantSlug, p_provider: provider, p_action: action}
    ));
    const connectionId = text(authorized?.connectionId);
    if (!connectionId) throw new AdsSyncError('marketing_authorization_failed', 403);
    const current = await connectionConfiguration(config, connectionId);
    const selected = adapter(provider);
    const account = await completeTest(config, current, selected);
    if (action === 'test_connection') {
      return json({success: true, identity: account});
    }

    const range = requestedRange(payload, current);
    const idempotencyKey = text(request.headers.get('x-idempotency-key'))
      || `manual:${connectionId}:${crypto.randomUUID()}`;
    return json(await synchronize(
      config,
      current,
      selected,
      account,
      range,
      'manual',
      idempotencyKey
    ) as unknown as JsonRecord);
  } catch (error) {
    const info = errorInfo(error);
    console.error('ads-sync', info.code, info.detail);
    const status = error instanceof AdsSyncError ? error.status : 500;
    return json({error: info.code, detail: info.detail}, status);
  }
});
