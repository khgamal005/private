import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [migration,reconciler,documentation]=await Promise.all([
  read('supabase/migrations/20260906123000_paymob_final_runtime_v1.sql'),
  read('supabase/functions/paymob-reconcile/index.ts'),
  read('docs/payments/paymob-final-runtime-v1.md')
]);

function functionBody(source,name){
  const start=source.indexOf(`function ${name}`);
  assert.notEqual(start,-1,`${name} must exist`);
  const next=source.indexOf('\nfunction ',start+10);
  return source.slice(start,next===-1?source.length:next);
}

test('the production scheduler is database-owned and never hides an Edge 401',()=>{
  assert.match(migration,/paymob_reconciliation_tick_v2/);
  assert.match(migration,/cron\.schedule\([\s\S]*?'odeir-paymob-runtime-v2'[\s\S]*?private_app\.paymob_reconciliation_tick_v2\(10\)/i);
  assert.match(migration,/cron\.unschedule/i);
  const schedule=migration.slice(migration.indexOf('do $schedule$'));
  assert.doesNotMatch(schedule,/net\.http_post|paymob-reconcile\/index|x-odeir-paymob-reconcile-secret/i);
});

test('QuickLink recovery uses Paymob order_id before merchant reference',()=>{
  assert.match(migration,/ODEIR_PAYMOB_ORDER_ID_RECOVERY_V1/);
  assert.match(migration,/jsonb_build_object\('order_id',v_provider_order_id\)/);
  assert.match(reconciler,/job\.providerOrderId[\s\S]*?inquireByOrderId/i);
  const inquiry=functionBody(reconciler,'inquireByOrderId');
  assert.match(inquiry,/\/api\/ecommerce\/orders\/transaction_inquiry/);
  assert.match(inquiry,/body:\s*JSON\.stringify\(\{\s*order_id:\s*orderId\s*\}\)/);
  assert.match(inquiry,/mode:\s*['"]merchant_order_id['"]/);
  assert.doesNotMatch(inquiry,/payment-links|\/v1\/intention|method:\s*['"]PUT['"]|method:\s*['"]DELETE['"]/i);
});

test('a missing transaction can close only an expired evidence-empty QuickLink',()=>{
  const finalizer=migration.slice(
    migration.indexOf('create or replace function private_app.paymob_finalize_no_transaction_v1'),
    migration.indexOf('-- Patch the already-reviewed inline worker')
  );
  assert.match(finalizer,/checkout_flow\s*<>\s*'quicklink'/i);
  assert.match(finalizer,/provider_order_id[\s\S]*?\^\[1-9\]/i);
  assert.match(finalizer,/provider_transaction_id is not null/i);
  assert.match(finalizer,/provider_expires_at[\s\S]*?interval '30 minutes'/i);
  assert.match(finalizer,/marketplace\.payment_events/i);
  assert.match(finalizer,/marketplace\.webhook_deliveries/i);
  assert.match(finalizer,/sibling\.status in/i);
  assert.match(finalizer,/pg_advisory_xact_lock/i);
  assert.match(finalizer,/status = 'failed'/i);
  assert.match(finalizer,/payment_status = 'failed'/i);
  assert.match(finalizer,/observed_state = 'provider_order_expired_no_transaction'/i);
  assert.doesNotMatch(finalizer,/payment_status\s*=\s*'paid'|activation_state\s*=|tenant_addon_subscriptions/i);
});

test('the minute tick retains promotion and checkout-secret hygiene',()=>{
  const tick=migration.slice(
    migration.indexOf('create or replace function private_app.paymob_reconciliation_tick_v2'),
    migration.indexOf('revoke all on function private_app.paymob_finalize_no_transaction_v1')
  );
  assert.match(tick,/paymob_reconcile_inline_v1\(p_max_jobs\)/);
  assert.match(tick,/marketplace_release_expired_promotions_v1\(200\)/);
  assert.match(tick,/v1_service_paymob_cleanup_checkout_secrets\(100\)/);
  assert.match(migration,/revoke all on function private_app\.paymob_finalize_no_transaction_v1[\s\S]*?public,anon,authenticated,service_role/i);
  assert.match(migration,/revoke all on function private_app\.paymob_reconciliation_tick_v2[\s\S]*?public,anon,authenticated,service_role/i);
});

test('legacy unresolved jobs are requeued only without payment evidence',()=>{
  const requeue=migration.slice(
    migration.indexOf('do $requeue$'),
    migration.indexOf('-- Replace the unreliable HTTP dispatcher')
  );
  assert.match(requeue,/reconciliation_type\s*=\s*'intention_unknown'/i);
  assert.match(requeue,/attempt\.status\s*=\s*'unknown'/i);
  assert.match(requeue,/provider_transaction_id is null/i);
  assert.match(requeue,/not exists[\s\S]*?marketplace\.payment_events/i);
  assert.match(requeue,/not exists[\s\S]*?marketplace\.webhook_deliveries/i);
  assert.match(requeue,/not exists[\s\S]*?payment_attempts sibling/i);
  assert.match(requeue,/attempt_count\s*=\s*0/i);
});

test('the runbook states the truthful release boundary',()=>{
  assert.match(documentation,/QuickLink Hosted Redirect/i);
  assert.match(documentation,/order_id/i);
  assert.match(documentation,/signed webhook/i);
  assert.match(documentation,/does not create|لا ينشئ/i);
  assert.match(documentation,/paid transaction|عملية دفع ناجحة/i);
  assert.match(documentation,/refund|استرداد/i);
});
