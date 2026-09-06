import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync(
  'supabase/migrations/20260906130000_paymob_retire_legacy_dispatcher_v1.sql',
  'utf8'
);
const config=readFileSync('supabase/config.toml','utf8');
const edge=readFileSync('supabase/functions/paymob-reconcile/index.ts','utf8');

function configBlock(name){
  const match=new RegExp(
    `^\\[functions\\.${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'im'
  ).exec(config);
  assert.ok(match,`Missing Supabase function config for ${name}`);
  return match[1];
}

test('retirement requires the exact database-owned scheduler first',()=>{
  assert.match(migration,/paymob_reconciliation_tick_v2\(integer\)/i);
  assert.match(migration,/v2_platform_paymob_reconcile_now\(integer\)/i);
  assert.match(migration,/jobname\s*=\s*'odeir-paymob-runtime-v2'/i);
  assert.match(migration,/schedule\s*=\s*'\* \* \* \* \*'/i);
  assert.match(migration,/command\s*=\s*'select private_app\.paymob_reconciliation_tick_v2\(10\);'/i);
  assert.match(migration,/paymob_database_owned_scheduler_not_ready/i);
});

test('old HTTP dispatcher functions and dedicated secret are removed',()=>{
  assert.match(migration,/drop function if exists private_app\.paymob_reconcile_dispatch_v1\(\)/i);
  assert.match(migration,/drop function if exists public\.v1_service_paymob_reconcile_dispatch_secret\(\)/i);
  assert.match(migration,/delete from vault\.secrets[\s\S]*?paymob_reconcile_dispatcher_v1/i);
  assert.match(migration,/dispatcherSecretsDeleted/i);
  assert.match(migration,/paymob_dispatcher_secret_cardinality_invalid/i);
});

test('manual gateway remains JWT and permission protected',()=>{
  assert.match(configBlock('paymob-reconcile'),/verify_jwt\s*=\s*true/i);
  assert.match(edge,/v2_platform_paymob_reconcile_now/);
  assert.doesNotMatch(edge,/PAYMOB_RECONCILE_DISPATCHER_SECRET|x-odeir-paymob-reconcile-secret|SUPABASE_SERVICE_ROLE_KEY/i);
});

test('retirement migration cannot mutate payment or entitlement state',()=>{
  assert.doesNotMatch(migration,/update\s+marketplace\.(?:orders|payment_attempts|reconciliations|refunds)/i);
  assert.doesNotMatch(migration,/insert\s+into\s+(?:catalog\.tenant_addon_subscriptions|marketplace\.payment_events)/i);
  assert.doesNotMatch(migration,/payment_status\s*=|activation_state\s*=|status\s*=\s*'paid'/i);
  assert.match(migration,/paymentStateChanged'\s*,\s*false/i);
  assert.match(migration,/providerMutation'\s*,\s*false/i);
});
