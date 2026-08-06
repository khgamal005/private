import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migration=await readFile(
  new URL(
    '../supabase/migrations/20260806214330_yeastar_department_rollups_v1.sql',
    import.meta.url
  ),
  'utf8'
);

test('department rollup follows the canonical role-based staff scope',()=>{
  assert.match(migration,/private_app\.v2_metric_staff_scope/);
  assert.match(migration,/staff\.id = any\(v_scope_staff_ids\)/);
  assert.match(migration,/extensionAssignments/);
  assert.match(migration,/people\.departments/);
});

test('each call is counted once within its department',()=>{
  assert.match(migration,/count\(distinct record\.id\) as total_calls/);
  assert.match(migration,/record\.involved_extensions && department\.extensions/);
  assert.match(migration,/group by\s+department\.department_key/);
});

test('department rollup enforces tenant access and the paid add-on',()=>{
  assert.match(migration,/tenant\.crm\.read/);
  assert.match(migration,/tenant\.settings\.manage/);
  assert.match(migration,/tenant_yeastar_addon_enabled/);
  assert.match(migration,/invalid_report_period/);
});

test('department RPC is exposed only to authenticated users',()=>{
  assert.match(migration,/revoke all on function[\s\S]+from public, anon/);
  assert.match(migration,/grant execute on function[\s\S]+to authenticated/);
  assert.match(migration,/security definer/);
  assert.match(migration,/set search_path = ''/);
});
