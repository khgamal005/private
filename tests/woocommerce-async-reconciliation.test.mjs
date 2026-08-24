import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const edge=await read('../supabase/functions/woocommerce-sync/index.ts');
const commerceRoute=await read(
  '../app/api/commerce/[provider]/[action]/route.js'
);
const legacyRoute=await read('../app/api/woocommerce/[action]/route.js');
const hub=await read('../components/commerce-integration-hub.js');
const legacyPanel=await read('../components/woocommerce-sync-panel.js');
const dashboard=await read('../components/role-dashboard.js');
const migration=await read(
  '../supabase/migrations/20260812134000_woocommerce_checkpoint_worker_v3.sql'
);
const resultsMigration=await read(
  '../supabase/migrations/20260812150000_woocommerce_results_revenue_v1.sql'
);
const dashboardMigration=await read(
  '../supabase/migrations/20260812165221_dashboard_month_to_date_v1.sql'
);
const api=await read('../lib/api.js');
const syncState=await import('../lib/woocommerce-sync-state.mjs');
const syncMachine=await import(
  '../supabase/functions/_shared/woocommerce-sync-machine.mjs'
);

test('manual WooCommerce sync queues a durable checkpoint run before processing',()=>{
  assert.match(edge,/async function queueManualSync/);
  assert.match(edge,/v3_woocommerce_start_sync/);
  assert.match(edge,/continue_sync/);
  assert.match(edge,/EdgeRuntime\.waitUntil\(/);
  assert.match(edge,/processOneDurableCheckpoint/);
  assert.match(edge,/accepted: start\.status === 'running'/);
  assert.match(edge,/result\.status === 'running' \? 202 : 200/);
  assert.match(edge,/start\.duplicate/);
  assert.match(edge,/runId: start\.runId/);
});

test('WooCommerce routes forward scope and a stable idempotency key',()=>{
  for(const route of [commerceRoute,legacyRoute]){
    assert.match(route,/x-idempotency-key/);
    assert.match(route,/scope:/);
    assert.match(route,/v2_tenant_woocommerce_snapshot/);
    assert.match(route,/status/);
    assert.match(route,/responseMode:action==='sync'\?'durable-v2':null/);
  }
  assert.match(commerceRoute,/data\?\.status==='running'\?202:200/);
  assert.match(legacyRoute,/response\.status/);
});

test('cursor machine resumes nested pages and completes every planned scope',()=>{
  const plan=syncMachine.buildWooSyncPlan([
    'attributes','attribute_terms','orders'
  ]);
  assert.deepEqual(plan,[
    {
      kind:'nested',
      parentEntity:'attributes',
      childEntity:'attribute_terms',
      storeParent:true
    },
    {kind:'plain',entityType:'orders'}
  ]);

  let cursor=syncMachine.initialWooSyncCursor('2026-08-12T00:00:00Z');
  cursor=syncMachine.cursorAfterWooMetadata(cursor,plan,{currency:'SAR'});
  assert.equal(cursor.mode,'parent');
  assert.equal(cursor.step,0);

  cursor=syncMachine.cursorAfterWooParentPage(cursor,plan,[10,11],true);
  cursor=syncMachine.recordWooSyncPage(cursor,'attributes',2);
  assert.equal(cursor.mode,'children');
  assert.equal(cursor.parentIds.length,2);
  assert.equal(cursor.nextParentPage,2);

  cursor=syncMachine.cursorAfterWooChildPage(cursor,plan,true);
  cursor=syncMachine.recordWooSyncPage(cursor,'attribute_terms',100);
  assert.equal(cursor.childPage,2);

  cursor=syncMachine.cursorAfterWooChildPage(cursor,plan,false);
  cursor=syncMachine.recordWooSyncPage(cursor,'attribute_terms',4);
  assert.equal(cursor.parentIndex,1);
  assert.equal(cursor.childPage,1);

  cursor=syncMachine.cursorAfterWooChildPage(cursor,plan,false);
  cursor=syncMachine.recordWooSyncPage(cursor,'attribute_terms',3);
  assert.equal(cursor.mode,'parent');
  assert.equal(cursor.page,2);

  cursor=syncMachine.cursorAfterWooParentPage(cursor,plan,[],false);
  assert.equal(cursor.mode,'page');
  assert.equal(cursor.step,1);
  cursor=syncMachine.cursorAfterWooPlainPage(cursor,plan,false);
  cursor=syncMachine.recordWooSyncPage(cursor,'orders',45);
  assert.equal(cursor.mode,'complete');
  assert.equal(cursor.retryCount,0);
  assert.equal(cursor.totals.attribute_terms,107);
  assert.equal(cursor.totals.orders,45);
  assert.equal(syncMachine.isWooSyncCursor(cursor),true);

  const completion=syncMachine.wooSyncCompletion(
    cursor,
    '2026-08-12T00:01:00Z'
  );
  assert.equal(completion.stats.durationMs,60_000);
  assert.equal(completion.remoteMetadata.currency,'SAR');
});

test('checkpoint migration uses leases, CAS and transactional continuation',()=>{
  for(const token of [
    'checkpoint_seq',
    'worker_id',
    'lease_expires_at',
    'next_attempt_at',
    'attempt_count',
    'for update skip locked',
    'v3_woocommerce_claim_run',
    'v3_woocommerce_store_batch_and_yield',
    'v3_woocommerce_checkpoint_and_yield',
    'v3_woocommerce_complete_claimed_run',
    'v3_woocommerce_requeue_recoverable',
    'private_app.enqueue_woocommerce_continuation'
  ])assert.match(migration,new RegExp(token.replaceAll('_','[_]'),'i'));
  assert.match(
    migration,
    /v_result := public\.v2_woocommerce_store_batch[\s\S]+perform private_app\.enqueue_woocommerce_continuation/
  );
  assert.match(migration,/woocommerce_sync_deployment_running_run/);
  assert.doesNotMatch(migration,/reef-skills/);
  assert.doesNotMatch(migration,/update\s+academy\.courses/i);
});

test('durable worker processes one remote page per checkpoint invocation',()=>{
  assert.match(edge,/async function durablePage/);
  assert.match(edge,/DURABLE_REMOTE_ATTEMPTS = 2/);
  assert.match(edge,/DURABLE_REMOTE_TIMEOUT_MS = 20_000/);
  assert.match(edge,/p_expected_seq: claim\.checkpointSeq/);
  assert.match(edge,/p_has_more: true/);
  assert.match(edge,/order: 'asc'/);
  assert.match(edge,/orderby: 'id'/);
  assert.match(edge,/v3_woocommerce_release_run/);
  assert.match(edge,/wooCheckpointRetryPolicy\(retryCount\)/);
  assert.doesNotMatch(edge,/claim\.attemptCount|attemptCount\s*</);
});

test('both WooCommerce interfaces poll the same run instead of retrying it',()=>{
  assert.match(hub,/useRef\(new Map\(\)\)/);
  assert.match(hub,/waitForWooSync\(result\.runId\)/);
  assert.match(hub,/pollWooSyncRun/);
  assert.match(hub,/completed\?\.status==='partial'/);
  assert.match(legacyPanel,/syncKey=useRef\(null\)/);
  assert.match(legacyPanel,/waitForSync\(result\.runId\)/);
  assert.match(legacyPanel,/pollWooSyncRun/);
  assert.match(legacyPanel,/completed\?\.status==='partial'/);
});

test('polling tolerates transient failures and resolves the original run',async()=>{
  let calls=0;
  const progress=[];
  const run=await syncState.pollWooSyncRun({
    runId:'run-1',
    maxAttempts:4,
    intervalMs:0,
    wait:async()=>{},
    onProgress:value=>progress.push(value.status),
    fetchSnapshot:async()=>{
      calls+=1;
      if(calls===1)throw new Error('temporary status failure');
      if(calls===2)return {recentRuns:[{runId:'run-1',status:'running'}]};
      return {
        recentRuns:[{
          runId:'run-1',
          status:'success',
          fetchedCount:3179
        }]
      };
    }
  });
  assert.equal(run.status,'success');
  assert.equal(syncState.wooSyncReviewedCount(run),3179);
  assert.equal(calls,3);
  assert.deepEqual(progress,['running','success']);
});

test('polling reports partial and failed terminal runs without restarting',async()=>{
  for(const status of ['partial','failed']){
    const run=await syncState.pollWooSyncRun({
      runId:'same-run',
      maxAttempts:1,
      intervalMs:0,
      wait:async()=>{},
      fetchSnapshot:async()=>({
        recentRuns:[{runId:'same-run',status,failedCount:2}]
      })
    });
    assert.equal(run.status,status);
    assert.equal(run.failedCount,2);
  }
});

test('attributes save includes attribute terms without widening other scopes',()=>{
  assert.match(hub,/providerKey==='woocommerce'/);
  assert.match(hub,/values\.includes\('attributes'\)/);
  assert.match(hub,/values\.push\('attribute_terms'\)/);
  assert.match(hub,/syncScope:normalizedScope/);
});

test('orders preserve paid time and separate financial components',()=>{
  assert.match(edge,/date_paid_gmt/);
  assert.match(edge,/paidAt: paidAt \|\| null/);
  assert.match(edge,/occurredAt: createdAt/);
  assert.match(edge,/createdAtGmt/);
  assert.match(edge,/paymentStatus: status/);
  assert.match(edge,/paidByDefaultWooStatus:/);
  for(const field of [
    'orderTotalMinor',
    'discountMinor',
    'refundTotalMinor',
    'taxMinor',
    'shippingMinor'
  ])assert.match(edge,new RegExp(field));
  assert.doesNotMatch(edge,/grossAmountMinor:/);
  assert.doesNotMatch(edge,/netAmountMinor:/);
});

test('dashboard separates Woo Analytics revenue from verified registrations',()=>{
  assert.match(edge,/wc-analytics/);
  assert.match(edge,/reports\/revenue\/stats/);
  assert.match(edge,/grossSalesMinor/);
  assert.match(edge,/netSalesMinor/);
  assert.match(edge,/requiredCount\('orders_count'\)/);
  assert.match(edge,/woocommerce_revenue_report_invalid/);
  assert.match(edge,/configuration\.syncTimezone/);
  assert.match(resultsMigration,/v2_tenant_role_dashboard_snapshot_v5/);
  assert.match(resultsMigration,/woocommerceRevenue/);
  assert.match(resultsMigration,/revenueReport/);
  assert.match(resultsMigration,/run\.finished_at < settings\.enabled_at/);
  assert.match(resultsMigration,/'orders' = any\(run\.scope\)/);
  assert.doesNotMatch(resultsMigration,/reef-skills/);
  assert.match(dashboardMigration,/v2_tenant_role_dashboard_snapshot_v5\(p_slug\)/);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v8/);
  assert.match(api,/p_from:from/);
  assert.match(api,/p_to:to/);
  assert.match(dashboard,/صافي مبيعات WooCommerce خلال الفترة/);
  assert.match(dashboard,/دفعات التسجيل المؤكدة خلال الفترة/);
  assert.match(dashboard,/منع الازدواج/);
});

test('integration results remain visible while users stay on provider cards',()=>{
  const noticePosition=hub.indexOf('role="status"');
  const gridPosition=hub.indexOf('<div className={styles.grid}>');
  assert.ok(noticePosition>0);
  assert.ok(gridPosition>noticePosition);
  assert.match(hub,/feedbackRegion/);
  assert.match(hub,/aria-atomic="true"/);
  assert.match(legacyPanel,/aria-live="polite"/);
  assert.match(hub,/onProgress:run/);
  assert.match(legacyPanel,/onProgress:run/);
});
