import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const [migration,edge,wrapper,documentation]=await Promise.all([
  readFile('supabase/migrations/20260906123000_paymob_final_runtime_v1.sql','utf8'),
  readFile('supabase/functions/paymob-reconcile/index.ts','utf8'),
  readFile('supabase/migrations/20260906124500_paymob_admin_reconcile_wrapper_v1.sql','utf8'),
  readFile('docs/payments/paymob-final-runtime-v1.md','utf8')
]);

test('production scheduler is database-owned and cannot hide an Edge authorization failure',()=>{
  assert.match(migration,/paymob_reconciliation_tick_v2/);
  assert.match(migration,/cron\.schedule\([\s\S]*?'odeir-paymob-runtime-v2'[\s\S]*?paymob_reconciliation_tick_v2\(10\)/i);
  assert.doesNotMatch(migration.slice(migration.indexOf('do $schedule$')),/net\.http_post|paymob-reconcile\/index/i);
});

test('QuickLink recovery uses documented Paymob order_id inquiry',()=>{
  assert.match(migration,/ODEIR_PAYMOB_ORDER_ID_RECOVERY_V1/);
  assert.match(migration,/jsonb_build_object\('order_id',v_provider_order_id\)/);
  assert.match(migration,/jsonb_build_object\('merchant_order_id',v_attempt_id::text\)/);
  assert.match(migration,/\/api\/ecommerce\/orders\/transaction_inquiry/);
});

test('missing transaction resolution is expired, evidence-empty and never marks paid',()=>{
  const finalizer=migration.slice(
    migration.indexOf('create or replace function private_app.paymob_finalize_no_transaction_v1'),
    migration.indexOf('-- Patch the already-reviewed inline worker')
  );
  assert.match(finalizer,/checkout_flow\s*<>\s*'quicklink'/i);
  assert.match(finalizer,/provider_expires_at[\s\S]*?interval '30 minutes'/i);
  assert.match(finalizer,/marketplace\.payment_events/i);
  assert.match(finalizer,/marketplace\.webhook_deliveries/i);
  assert.match(finalizer,/sibling\.status in/i);
  assert.match(finalizer,/status = 'failed'/i);
  assert.match(finalizer,/payment_status = 'failed'/i);
  assert.doesNotMatch(finalizer,/payment_status\s*=\s*'paid'|activation_state\s*=|tenant_addon_subscriptions/i);
});

test('manual Edge endpoint delegates only to the permission-gated database tick',()=>{
  assert.match(edge,/v2_platform_paymob_reconcile_now/);
  assert.doesNotMatch(edge,/ksa\.paymob\.com|SUPABASE_SERVICE_ROLE_KEY|PAYMOB_RECONCILE_DISPATCHER_SECRET/i);
  assert.match(wrapper,/platform\.billing\.manage/);
  assert.match(wrapper,/paymob_reconciliation_tick_v2/);
});

test('runbook states the truthful release boundary',()=>{
  assert.match(documentation,/QuickLink Hosted Redirect/i);
  assert.match(documentation,/order_id/i);
  assert.match(documentation,/signed webhook/i);
  assert.match(documentation,/does not create|لا ينشئ/i);
  assert.match(documentation,/paid transaction|عملية دفع ناجحة/i);
  assert.match(documentation,/refund|استرداد/i);
});
