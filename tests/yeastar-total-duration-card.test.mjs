import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migration=await readFile(
  new URL(
    '../supabase/migrations/20260816170000_yeastar_total_talk_and_ring_duration_v1.sql',
    import.meta.url
  ),
  'utf8'
);

test('combined duration uses exact routing plus handling seconds',()=>{
  assert.match(migration,/sum\(record\.routing_duration_seconds\)/);
  assert.match(migration,/record\.routing_duration_seconds::bigint[\s\S]+record\.handling_duration_seconds::bigint/);
  assert.match(migration,/'totalRoutingSeconds'/);
  assert.match(migration,/'totalTalkAndRingSeconds'/);
});

test('combined duration follows the same tenant, employee, and report filters',()=>{
  assert.match(migration,/record\.tenant_id = v_tenant_id/);
  assert.match(migration,/record\.involved_extensions && v_staff_extensions/);
  assert.match(migration,/p_extension = any\(record\.involved_extensions\)/);
  assert.match(migration,/record\.call_type = p_call_type/);
  assert.match(migration,/record\.final_status = p_status/);
});

test('the report RPC keeps its authorization and add-on boundaries',()=>{
  assert.match(migration,/private_app\.has_tenant_permission/);
  assert.match(migration,/private_app\.tenant_yeastar_addon_enabled/);
  assert.match(migration,/security definer/);
  assert.match(migration,/set search_path = ''/);
  assert.match(migration,/revoke all on function[\s\S]+from public, anon/);
  assert.match(migration,/grant execute on function[\s\S]+to authenticated/);
});
