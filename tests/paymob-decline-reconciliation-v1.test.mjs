import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync(
  'supabase/migrations/20260905213000_paymob_decline_reconciliation_v1.sql',
  'utf8'
);
const reconciler=readFileSync('supabase/functions/paymob-reconcile/index.ts','utf8');
const statusRoute=readFileSync('app/api/payments/paymob/status/route.js','utf8');
const returnUi=readFileSync('components/paymob-return-status.js','utf8');

test('every durable QuickLink receives one bounded read-only inquiry job',()=>{
  assert.match(migration,/after insert or update of status,provider_order_id/i);
  assert.match(migration,/new\.checkout_flow <> 'quicklink'/i);
  assert.match(migration,/new\.status <> 'intention_created'/i);
  assert.match(migration,/reconciliation_type[\s\S]*?'transaction_inquiry'/i);
  assert.match(migration,/now\(\) \+ interval '30 seconds'/i);
  assert.match(migration,/max_attempts[\s\S]*?10/i);
  assert.match(migration,/on conflict \(attempt_id,reconciliation_type\) do update/i);
  const triggerBody=migration.slice(
    migration.indexOf('create or replace function private_app.paymob_queue_quicklink_reconciliation_v1'),
    migration.indexOf('drop trigger if exists paymob_queue_quicklink_reconciliation_v1')
  );
  assert.doesNotMatch(triggerBody,/update\s+marketplace\.orders/i);
});

test('scheduler secret stays Vault-backed and cron dispatch is minute-bounded',()=>{
  assert.match(migration,/vault\.create_secret/i);
  assert.match(migration,/paymob_reconcile_dispatcher_v1/);
  assert.match(migration,/v1_service_paymob_reconcile_dispatch_secret/);
  assert.match(migration,/coalesce\(auth\.jwt\(\) ->> 'role',''\) <> 'service_role'/i);
  assert.match(migration,/net\.http_post/i);
  assert.match(migration,/x-odeir-paymob-reconcile-secret/i);
  assert.match(migration,/cron\.schedule[\s\S]*?'\* \* \* \* \*'/i);
  assert.doesNotMatch(migration,/PAYMOB_RECONCILE_DISPATCHER_SECRET\s*=/i);
});

test('reconciler validates the Vault secret timing-safely and keeps admin fallback',()=>{
  assert.match(reconciler,/v1_service_paymob_reconcile_dispatch_secret/);
  assert.match(reconciler,/serviceRoleKey/);
  assert.match(reconciler,/allowedKeys = new Set\(\["schemaVersion", "dispatcherSecret"\]\)/);
  assert.match(reconciler,/secretEqual\(vaultSecret, suppliedSecret\)/);
  assert.match(reconciler,/v3_platform_payment_provider_admin_snapshot/);
  assert.doesNotMatch(reconciler,/console\.(?:log|info|debug)[^\n]*dispatcherSecret/i);
});

test('browser receives only a safe decline classification and no provider text',()=>{
  assert.match(statusRoute,/RESULT_CODES/);
  assert.match(statusRoute,/issuer_declined_retry_available/);
  assert.match(statusRoute,/retryAllowed/);
  assert.doesNotMatch(statusRoute,/lastErrorCode\s*:/);
  assert.doesNotMatch(statusRoute,/providerResponse|do not honour/i);
});

test('return page stops noisy polling and gives one simple recovery path',()=>{
  assert.match(returnUi,/setPhase\('declined'\)/);
  assert.match(returnUi,/رفض البنك عملية الدفع/);
  assert.match(returnUi,/استكمال الدفع/);
  assert.match(returnUi,/لا تحتاج إلى إنشاء طلب جديد/);
  assert.match(returnUi,/\['paused','declined'\]\.includes\(phase\)/);
  assert.doesNotMatch(returnUi,/window\.location|fetch\('\/api\/payments\/paymob\/checkout/);
});
