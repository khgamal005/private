import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('CRM egress gateway grants are short-lived, hash-bound, and single-use',async()=>{
  const migration=await read(
    'supabase/migrations/20260806200440_secure_yeastar_hostinger_gateway_v4.sql'
  );

  assert.match(migration,/private_app\.yeastar_gateway_requests/);
  assert.match(migration,/interval '90 seconds'/);
  assert.match(migration,/request_hash = lower/);
  assert.match(migration,/claimed_at is null/);
  assert.match(migration,/set claimed_at = clock_timestamp\(\)/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/grant execute[\s\S]*v4_yeastar_gateway_issue\(text\)[\s\S]*to service_role/);
  assert.match(migration,/grant execute[\s\S]*v4_yeastar_gateway_claim\(uuid, text\)[\s\S]*to anon/);
  assert.match(migration,/set search_path = ''/);
});

test('Yeastar Edge connector always obtains a one-time gateway grant',async()=>{
  const edge=await read('supabase/functions/yeastar-sync/index.ts');

  assert.match(edge,/YEASTAR_EGRESS_GATEWAY_URL/);
  assert.match(edge,/marktone\.org\/api\/integrations\/yeastar\/egress/);
  assert.match(edge,/crypto\.subtle\.digest/);
  assert.match(edge,/v4_yeastar_gateway_issue/);
  assert.match(edge,/x-marktone-gateway-grant/);
  assert.match(edge,/x-marktone-request-sha256/);
  assert.match(edge,/await gatewayFetch\(/);
  assert.doesNotMatch(edge,/YEASTAR_GATEWAY_URL\s*\?/);
});

test('CDR sync reuses the proven CRM v1 filtered search contract',async()=>{
  const edge=await read('supabase/functions/yeastar-sync/index.ts');

  assert.match(edge,/\/openapi\/v1\.0\/cdr\/search/);
  assert.match(edge,/start_time/);
  assert.match(edge,/end_time/);
  assert.match(edge,/fetchDirection\(extension,'call_from'\)/);
  assert.match(edge,/fetchDirection\(extension,'call_to'\)/);
  assert.match(edge,/recommendedApiVersion:'v1\.0'/);
});
