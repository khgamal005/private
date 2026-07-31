import type {
  CommerceAdapter,
  CommerceEntity,
  ConnectionConfiguration,
  Json,
  JsonRecord
} from './types.ts';
import {CommerceError, asRecord, text, valueAt} from './shared.ts';
import {sallaAdapter} from './adapters/salla.ts';
import {zidAdapter} from './adapters/zid.ts';
import {shopifyAdapter} from './adapters/shopify.ts';
import {customAdapter} from './adapters/custom.ts';

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_PROVIDERS = new Set(['salla', 'zid', 'shopify', 'custom']);
const ALLOWED_ACTIONS = new Set(['test_connection', 'sync_now']);

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-idempotency-key',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
  vary: 'Origin'
};
const jsonHeaders = {
  ...corsHeaders,
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0'
};

class RpcError extends CommerceError {
  constructor(name: string, status: number, detail = '') {
    super(`commerce_rpc_${name}_${status}${detail ? `:${detail}` : ''}`, status === 401 ? 401 : 500);
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

function keys() {
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

function unwrap(value: Json): Json {
  if (Array.isArray(value) && value.length === 1) return unwrap(value[0]);
  return value;
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
    const detail = text(valueAt(asRecord(payload) || {}, 'message', 'hint', 'details')).slice(0, 180);
    throw new RpcError(name, response.status, detail);
  }
  return unwrap(payload);
}

function rpcUser(config: ReturnType<typeof keys>, token: string, name: string, body: JsonRecord) {
  return rpc(config.url, config.publishable, token, name, body);
}

function rpcService(config: ReturnType<typeof keys>, name: string, body: JsonRecord) {
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
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

async function body(request: Request): Promise<JsonRecord> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new CommerceError('request_too_large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new CommerceError('request_too_large', 413);
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    const record = asRecord(parsed);
    if (!record) throw new Error('not_object');
    return record;
  } catch {
    throw new CommerceError('invalid_request_json', 400);
  }
}

function adapter(provider: string): CommerceAdapter {
  if (provider === 'salla') return sallaAdapter;
  if (provider === 'zid') return zidAdapter;
  if (provider === 'shopify') return shopifyAdapter;
  if (provider === 'custom') return customAdapter;
  throw new CommerceError('commerce_provider_not_supported', 400);
}

function configuration(value: Json): ConnectionConfiguration {
  const record = asRecord(value);
  if (!record || !text(record.connectionId) || !text(record.providerKey)) {
    throw new CommerceError('commerce_configuration_invalid', 500);
  }
  return record as unknown as ConnectionConfiguration;
}

function scopeFrom(requested: Json, connection: ConnectionConfiguration) {
  const enabled = Array.isArray(connection.syncScope)
    ? connection.syncScope.map(value => text(value))
    : [];
  const values = Array.isArray(requested)
    ? requested.map(value => text(value)).filter(Boolean)
    : enabled;
  const unique = [...new Set(values)].filter(value => enabled.includes(value));
  if (!unique.length || !unique.includes('products')) unique.unshift('products');
  return unique as CommerceEntity[];
}

async function testConnection(
  config: ReturnType<typeof keys>,
  connection: ConnectionConfiguration,
  selected: CommerceAdapter
) {
  try {
    const identity = await selected.test(connection);
    await rpcService(config, 'v2_commerce_hub_finish_test', {
      p_connection_id: connection.connectionId,
      p_success: true,
      p_identity: identity,
      p_error: null
    });
    return {success: true, identity};
  } catch (error) {
    const message = error instanceof Error ? error.message : 'connection_test_failed';
    await rpcService(config, 'v2_commerce_hub_finish_test', {
      p_connection_id: connection.connectionId,
      p_success: false,
      p_identity: {},
      p_error: message.slice(0, 1000)
    }).catch(() => null);
    throw error;
  }
}

async function synchronize(
  config: ReturnType<typeof keys>,
  connection: ConnectionConfiguration,
  selected: CommerceAdapter,
  selectedScope: CommerceEntity[],
  idempotencyKey: string
) {
  const started = asRecord(await rpcService(config, 'v2_commerce_hub_start_sync', {
    p_connection_id: connection.connectionId,
    p_trigger: 'manual',
    p_scope: selectedScope,
    p_idempotency_key: idempotencyKey
  }));
  const runId = text(started?.runId);
  if (!runId) throw new CommerceError('commerce_run_start_failed', 500);
  if (Boolean(started?.duplicate)) {
    return {success: true, duplicate: true, runId, status: text(started?.status)};
  }

  const totals: Record<string, number> = {};
  let failedCount = 0;
  try {
    for (const entity of selectedScope) {
      totals[entity] = 0;
      for await (const page of selected.pages(connection, entity)) {
        const stored = asRecord(await rpcService(config, 'v2_commerce_hub_store_batch', {
          p_connection_id: connection.connectionId,
          p_run_id: runId,
          p_entity_type: entity,
          p_items: page.items,
          p_cursor: page.cursor,
          p_has_more: page.hasMore
        }));
        totals[entity] += Number(stored?.storedCount || 0);
        failedCount += Number(stored?.failedCount || 0);
      }
    }
    const status = failedCount > 0 ? 'partial' : 'success';
    const finished = await rpcService(config, 'v2_commerce_hub_finish_sync', {
      p_connection_id: connection.connectionId,
      p_run_id: runId,
      p_status: status,
      p_stats: {totals, failedCount},
      p_error: failedCount > 0 ? 'some_entities_failed_validation' : null,
      p_remote_metadata: {providerKey: connection.providerKey}
    });
    return {success: true, duplicate: false, runId, status, totals, finished};
  } catch (error) {
    const message = error instanceof Error ? error.message : 'commerce_sync_failed';
    await rpcService(config, 'v2_commerce_hub_finish_sync', {
      p_connection_id: connection.connectionId,
      p_run_id: runId,
      p_status: 'failed',
      p_stats: {totals, failedCount},
      p_error: message.slice(0, 1000),
      p_remote_metadata: {providerKey: connection.providerKey}
    }).catch(() => null);
    throw error;
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});
  if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);

  try {
    const config = keys();
    if (!config.url || !config.publishable || !config.service) {
      throw new CommerceError('supabase_environment_missing', 500);
    }
    const token = bearer(request);
    if (!token) throw new CommerceError('authentication_required', 401);
    const payload = await body(request);
    const tenantSlug = text(payload.tenantSlug);
    const provider = text(payload.provider).toLowerCase();
    const action = text(payload.action).toLowerCase();
    if (!tenantSlug || !ALLOWED_PROVIDERS.has(provider) || !ALLOWED_ACTIONS.has(action)) {
      throw new CommerceError('invalid_commerce_request', 400);
    }

    const authorized = asRecord(await rpcUser(config, token, 'v2_commerce_hub_authorize', {
      p_tenant_slug: tenantSlug,
      p_provider: provider,
      p_action: action
    }));
    const connectionId = text(authorized?.connectionId);
    if (!connectionId) throw new CommerceError('commerce_authorization_failed', 403);

    const connection = configuration(await rpcService(
      config,
      'v2_commerce_hub_connection_configuration',
      {p_connection_id: connectionId}
    ));
    const selected = adapter(provider);
    if (action === 'test_connection') {
      return json(await testConnection(config, connection, selected) as unknown as JsonRecord);
    }

    const selectedScope = scopeFrom(payload.scope, connection);
    const idempotencyKey = text(request.headers.get('x-idempotency-key'))
      || `${connection.connectionId}:${crypto.randomUUID()}`;
    return json(await synchronize(
      config,
      connection,
      selected,
      selectedScope,
      idempotencyKey
    ) as unknown as JsonRecord);
  } catch (error) {
    console.error('commerce-sync', error instanceof Error ? error.message : error);
    const status = error instanceof CommerceError ? error.status : 500;
    const code = error instanceof CommerceError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'commerce_sync_failed';
    return json({error: code.slice(0, 500)}, status);
  }
});
