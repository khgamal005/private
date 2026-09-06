import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const seed=readFileSync('supabase/migrations/20260905213000_paymob_decline_reconciliation_v1.sql','utf8');
const runtime=readFileSync('supabase/migrations/20260906123000_paymob_final_runtime_v1.sql','utf8');
const edge=readFileSync('supabase/functions/paymob-reconcile/index.ts','utf8');
const statusRoute=readFileSync('app/api/payments/paymob/status/route.js','utf8');
const returnUi=readFileSync('components/paymob-return-status.js','utf8');

test('every durable QuickLink still receives one bounded inquiry job',()=>{
  assert.match(seed,/after insert or update of status,provider_order_id/i);
  assert.match(seed,/new\.checkout_flow <> 'quicklink'/i);
  assert.match(seed,/reconciliation_type[\s\S]*?'transaction_inquiry'/i);
  assert.match(seed,/on conflict \(attempt_id,reconciliation_type\) do update/i);
});

test('final scheduler supersedes the historical HTTP dispatcher',()=>{
  assert.match(runtime,/cron\.unschedule/i);
  assert.match(runtime,/odeir-paymob-reconcile-v1/);
  assert.match(runtime,/odeir-paymob-runtime-v2/);
  assert.match(runtime,/select private_app\.paymob_reconciliation_tick_v2\(10\)/i);
  assert.doesNotMatch(runtime.slice(runtime.indexOf('do $schedule$')),/net\.http_post/i);
  assert.doesNotMatch(edge,/dispatcherSecret|PAYMOB_RECONCILE_DISPATCHER_SECRET|serviceRoleKey/i);
});

test('browser receives only safe decline classifications',()=>{
  assert.match(statusRoute,/RESULT_CODES/);
  assert.match(statusRoute,/issuer_declined_retry_available/);
  assert.match(statusRoute,/retryAllowed/);
  assert.doesNotMatch(statusRoute,/lastErrorCode\s*:/);
  assert.doesNotMatch(statusRoute,/providerResponse|do not honour/i);
});

test('return page stops polling and gives one simple retry path',()=>{
  assert.match(returnUi,/setPhase\('declined'\)/);
  assert.match(returnUi,/رفض البنك عملية الدفع/);
  assert.match(returnUi,/استكمال الدفع/);
  assert.match(returnUi,/لا تحتاج إلى إنشاء طلب جديد/);
  assert.doesNotMatch(returnUi,/fetch\('\/api\/payments\/paymob\/checkout/);
});
