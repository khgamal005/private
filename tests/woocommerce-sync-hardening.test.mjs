import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  retryableWooRpcFailure,
  safeWooRpcDiagnostic,
  wooCheckpointRetryPolicy
} from '../supabase/functions/_shared/woocommerce-sync-failure-policy.mjs';
import {
  prepareWooJsonbItem,
  restoreWooJsonbValue
} from '../supabase/functions/_shared/woocommerce-jsonb-safety.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const edge=await read('../supabase/functions/woocommerce-sync/index.ts');
const migration=await read(
  '../supabase/migrations/20260824193000_woocommerce_order_routing_fault_isolation_v1.sql'
);

test('RPC diagnostics keep only allowlisted non-PII codes',()=>{
  const unsafe=JSON.stringify({
    code:'23505',
    message:'duplicate customer@example.com +966500000000',
    details:'consumer_secret=do-not-copy',
    hint:'phone +966500000000'
  });
  const diagnostic=safeWooRpcDiagnostic(unsafe);
  assert.deepEqual(diagnostic,{databaseCode:'23505',messageCode:''});
  assert.doesNotMatch(JSON.stringify(diagnostic),/@|9665|secret/i);
  assert.deepEqual(
    safeWooRpcDiagnostic(JSON.stringify({
      code:'P0001',
      message:'woocommerce_sync_checkpoint_conflict'
    })),
    {
      databaseCode:'p0001',
      messageCode:'woocommerce_sync_checkpoint_conflict'
    }
  );
  assert.deepEqual(
    safeWooRpcDiagnostic('{not-json'),
    {databaseCode:'',messageCode:''}
  );
});

test('checkpoint retry policy is per cursor and bounded',()=>{
  assert.equal(retryableWooRpcFailure({
    httpStatus:500,
    databaseCode:'40001'
  }),true);
  assert.equal(retryableWooRpcFailure({
    httpStatus:503,
    databaseCode:''
  }),true);
  assert.equal(retryableWooRpcFailure({
    httpStatus:400,
    databaseCode:'23505'
  }),false);
  assert.equal(retryableWooRpcFailure({
    httpStatus:400,
    databaseCode:'p0001'
  }),false);
  assert.deepEqual(
    [0,1,2,3,4].map(count=>wooCheckpointRetryPolicy(count).delaySeconds),
    [60,120,240,480,900]
  );
  assert.equal(wooCheckpointRetryPolicy(5).retry,false);
  assert.doesNotMatch(edge,/claim\.attemptCount|attemptCount\s*</);
  assert.match(edge,/wooCheckpointRetryPolicy\(retryCount\)/);
});

test('unsupported jsonb code units are preserved with reversible encoding',()=>{
  const original={
    id:7590,
    customer_note:'alpha\u0000omega',
    meta:{
      loneSurrogate:'before\ud800after',
      emoji:'✅',
      slash:'a\\b'
    },
    _marktone:{source:'test'}
  };
  const prepared=prepareWooJsonbItem(original);
  assert.equal(
    prepared._marktone.jsonbEncoding.codec,
    'marktone-jsonb-escape-v1'
  );
  assert.equal(prepared._marktone.jsonbEncoding.unsupportedCodeUnits,2);
  const serialized=JSON.stringify(prepared);
  assert.match(serialized,/marktone-jsonb-escape-v1/);
  assert.doesNotMatch(serialized,/alpha\u0000omega/);

  const encodedWithoutDiagnostic=structuredClone(prepared);
  delete encodedWithoutDiagnostic._marktone.jsonbEncoding;
  assert.deepEqual(restoreWooJsonbValue(encodedWithoutDiagnostic),original);
  assert.equal(prepareWooJsonbItem({emoji:'✅'}).emoji,'✅');
  const hostile=prepareWooJsonbItem(JSON.parse(
    '{"__proto__":"safe","note":"bad\\u0000value"}'
  ));
  assert.equal(Object.hasOwn(hostile,'__proto__'),true);
  assert.equal(hostile.__proto__,'safe');
  assert.equal(Object.prototype.safe,undefined);
  const reserved=prepareWooJsonbItem({
    _marktone:'remote-value',
    note:'bad\u0000value'
  });
  assert.equal(reserved._marktone,'remote-value');
  assert.equal(
    (edge.match(/p_items: prepareWooJsonbItems\(items\)/g)||[]).length,
    2
  );
});

test('routing migration isolates only record-local failures',()=>{
  assert.match(migration,/lock table commerce_sync\.sync_runs/i);
  assert.match(migration,/woocommerce_sync_migration_running_run/);
  assert.match(
    migration,
    /v_attempted := v_attempted \+ 1;[\s\S]+begin[\s\S]+exception[\s\S]+when others/i
  );
  assert.match(migration,/get stacked diagnostics/i);
  assert.match(migration,/left\(v_error_sqlstate, 2\) = '22'/i);
  assert.match(migration,/v_error_sqlstate in \([\s\S]+'23505'/i);
  assert.match(migration,/else 'woocommerce_order_routing_constraint_'/i);
  assert.match(migration,/then\s+raise;/i);
  assert.match(migration,/entity\.tenant_id = v_connection\.tenant_id/i);
  assert.match(migration,/work_item\.tenant_id = v_connection\.tenant_id/i);
  assert.match(migration,/entity\.last_seen_run_id = p_run_id/i);
  assert.match(migration,/sync_state = 'error'/i);
  assert.match(migration,/failed_count = coalesce\(run\.failed_count, 0\)/i);
  assert.match(migration,/'failed', v_failed/i);
  assert.match(migration,/security definer[\s\S]+set search_path = ''/i);
  assert.match(migration,/revoke all on function private_app/i);
  assert.doesNotMatch(migration,/sqlerrm|pg_exception_detail/i);
  assert.doesNotMatch(migration,/reef-skills|consumer_secret|academy\.courses/i);
  assert.doesNotMatch(migration,/cron\.|v3_woocommerce_store_batch_and_yield/i);
});
