import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const edge=readFileSync('supabase/functions/paymob-reconcile/index.ts','utf8');
const config=readFileSync('supabase/config.toml','utf8');
const core=readFileSync('supabase/migrations/20260901134621_paymob_intention_checkout_v1.sql','utf8');
const runtime=readFileSync('supabase/migrations/20260906123000_paymob_final_runtime_v1.sql','utf8');
const wrapper=readFileSync('supabase/migrations/20260906124500_paymob_admin_reconcile_wrapper_v1.sql','utf8');
const runbook=readFileSync('supabase/functions/paymob-reconcile/README.md','utf8');

function configBlock(name){
  const match=new RegExp(
    `^\\[functions\\.${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'im'
  ).exec(config);
  assert.ok(match,`Missing Supabase function config for ${name}`);
  return match[1];
}

test('manual Edge gateway is JWT-only, permission-delegated and provider-blind',()=>{
  assert.match(configBlock('paymob-reconcile'),/verify_jwt\s*=\s*true/i);
  assert.match(edge,/v2_platform_paymob_reconcile_now/);
  assert.match(edge,/SUPABASE_ANON_KEY/);
  assert.match(edge,/authorization/);
  assert.match(edge,/p_max_jobs:maxJobs|p_max_jobs:\s*maxJobs/);
  assert.doesNotMatch(edge,/SUPABASE_SERVICE_ROLE_KEY|PAYMOB_RECONCILE_DISPATCHER_SECRET|x-odeir-paymob-reconcile-secret/i);
  assert.doesNotMatch(edge,/ksa\.paymob\.com|api_key|payment_provider_secret_refs|vault\./i);
  assert.doesNotMatch(edge,/Access-Control-Allow-Origin|\borigin\s*:\s*['"]\*['"]/i);
});

test('manual gateway is small, bounded and fail-closed',()=>{
  assert.match(edge,/MAX_REQUEST_BYTES\s*=\s*4\s*\*\s*1024/);
  assert.match(edge,/MAX_RESPONSE_BYTES\s*=\s*64\s*\*\s*1024/);
  assert.match(edge,/maxJobs\s*=\s*3/);
  assert.match(edge,/requested[^\n]*<\s*1[\s\S]*?requested[^\n]*>\s*10/i);
  assert.match(edge,/AbortSignal\.timeout\(30_000\)/);
  assert.match(edge,/payload_too_large/);
  assert.match(edge,/reconciliation_timeout/);
  assert.match(edge,/cache-control["'],\s*["']no-store/i);
});

test('database owns scheduling, leases, cleanup and financial classification',()=>{
  assert.match(runtime,/paymob_reconciliation_tick_v2/);
  assert.match(runtime,/cron\.schedule\([\s\S]*?'odeir-paymob-runtime-v2'[\s\S]*?paymob_reconciliation_tick_v2\(10\)/i);
  const schedule=runtime.slice(runtime.indexOf('do $schedule$'));
  assert.doesNotMatch(schedule,/net\.http_post|functions\/v1\/paymob-reconcile|dispatcher/i);
  assert.match(runtime,/marketplace_release_expired_promotions_v1\(200\)/);
  assert.match(runtime,/v1_service_paymob_cleanup_checkout_secrets\(100\)/);
  assert.match(core,/v1_service_paymob_reconciliation_claim/);
  assert.match(core,/for\s+update\s+skip\s+locked/i);
  assert.match(core,/v1_service_paymob_reconciliation_apply/);
  assert.match(core,/p_response_sha256/i);
});

test('manual RPC independently enforces platform billing permission',()=>{
  assert.match(wrapper,/v2_platform_paymob_reconcile_now/);
  assert.match(wrapper,/has_platform_permission\('platform\.billing\.manage'\)/);
  assert.match(wrapper,/p_max_jobs\s+is\s+null[\s\S]*?not\s+between\s+1\s+and\s+10/i);
  assert.match(wrapper,/return\s+private_app\.paymob_reconciliation_tick_v2\(p_max_jobs\)/i);
  assert.match(wrapper,/revoke all[\s\S]*?public,anon,service_role/i);
  assert.match(wrapper,/grant execute[\s\S]*?authenticated/i);
});

test('runbook reflects the deployed architecture',()=>{
  assert.match(runbook,/database-owned/i);
  assert.match(runbook,/JWT-protected|JWT/i);
  assert.match(runbook,/order_id/i);
  assert.match(runbook,/signed HMAC webhook/i);
  assert.doesNotMatch(runbook,/PAYMOB_RECONCILE_DISPATCHER_SECRET|x-odeir-paymob-reconcile-secret/);
});
