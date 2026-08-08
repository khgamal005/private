import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const migration=await readFile(
  new URL('../supabase/migrations/20260729215925_yeastar_p550_telephony_v2.sql',import.meta.url),
  'utf8'
);
const syncIndex=await readFile(
  new URL('../supabase/migrations/20260729220243_yeastar_sync_runs_tenant_index.sql',import.meta.url),
  'utf8'
);
const edge=await readFile(
  new URL('../supabase/functions/yeastar-sync/index.ts',import.meta.url),
  'utf8'
);
const api=await readFile(
  new URL('../app/api/yeastar/[action]/route.js',import.meta.url),
  'utf8'
);
const reports=await readFile(
  new URL('../components/yeastar-reports.js',import.meta.url),
  'utf8'
);
const reportPage=await readFile(
  new URL('../app/tenant/[slug]/yeastar/page.js',import.meta.url),
  'utf8'
);

test('Yeastar storage is tenant isolated and credentials remain in Vault',()=>{
  const settingsSnapshot=migration.slice(
    migration.indexOf('create or replace function public.v2_tenant_yeastar_settings_snapshot'),
    migration.indexOf('create or replace function public.v2_tenant_yeastar_action')
  );
  assert.match(migration,/create schema if not exists telephony/);
  assert.match(migration,/alter table telephony\.call_records enable row level security/);
  assert.match(migration,/revoke all on all tables in schema telephony/);
  assert.match(migration,/integration_secret_upsert/);
  assert.match(migration,/configuredSecrets/);
  assert.match(migration,/v2_yeastar_sync_failed/);
  assert.match(syncIndex,/tenant_id, started_at desc/);
  assert.doesNotMatch(settingsSnapshot,/decrypted_secret/);
});

test('connector follows Yeastar token lifecycle and firmware compatibility',()=>{
  assert.match(edge,/\/openapi\/v1\.0\/get_token/);
  assert.match(edge,/\/openapi\/v1\.0\/del_token/);
  assert.match(edge,/User-Agent/);
  assert.match(edge,/37,23,0,123/);
  assert.match(edge,/supportsV2:versionAtLeast\(device\.firmwareVersion,\[37,23,0,123\]\)/);
  assert.match(edge,/recommendedApiVersion:'v1\.0'/);
  assert.doesNotMatch(edge,/supportsV2Search/);
  assert.match(edge,/start_time/);
  assert.match(edge,/end_time/);
  assert.match(edge,/access_token=\[REDACTED\]/);
});

test('connector blocks private-network SSRF and uses authenticated application routes',()=>{
  assert.match(edge,/url\.protocol!=='https:'/);
  assert.match(edge,/192\\\.168/);
  assert.match(edge,/redirect:'error'/);
  assert.match(api,/ACCESS_COOKIE/);
  assert.match(api,/authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(api,/SERVICE_ROLE|service_role/);
});

test('reports cover operational call KPIs and missed-call callbacks',()=>{
  assert.match(migration,/returnedAfterMissed/);
  assert.match(migration,/answerRate/);
  assert.match(migration,/averageRoutingSeconds/);
  assert.match(migration,/involved_extensions/);
  assert.match(reports,/أداء التحويلات/);
  assert.match(reports,/لم يُعد الاتصال/);
  assert.match(reports,/مؤشر فقط دون نسخ الصوت/);
  assert.match(reportPage,/YEASTAR_SCHEMA_PENDING/);
});
