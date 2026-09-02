import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const migrationPath=
  'supabase/migrations/20260902133000_odeiry_manager_real_tenant_member_access_v1.sql';

test('dual platform and tenant users need exact tenant manager entitlement',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/^begin;/);
  assert.match(sql,/commit;\s*$/);
  assert.match(sql,/private_app\.support_is_active_tenant_member\(p_tenant_id\)/);
  assert.match(sql,/membership\.scope='tenant'/);
  assert.match(sql,/membership\.tenant_id=p_tenant_id/);
  assert.match(sql,/role\.scope='tenant'/);
  assert.match(
    sql,
    /role_permission\.permission_key='tenant\.odeiry_manager\.use'/
  );
  assert.doesNotMatch(sql,/platform_membership\.scope='platform'/);
  assert.doesNotMatch(
    sql,
    /and not private_app\.odeiry_is_platform_operator\(p_tenant_id\)/
  );
});

test('platform-only preview stays outside manager mode',async()=>{
  const sql=await read(migrationPath);
  assert.match(
    sql,
    /v_access_mode:=case[\s\S]+?support_is_active_tenant_member[\s\S]+?'tenant_member'[\s\S]+?odeiry_is_platform_operator[\s\S]+?'platform_operator'/
  );
  assert.match(
    sql,
    /v_manager_allowed:=v_access_mode='tenant_member'\s+and private_app\.odeiry_manager_can_use\(v_tenant\.id\)/
  );
});

test('snapshot remains a closed authenticated RPC',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/security definer\s+set search_path=''/);
  assert.match(
    sql,
    /revoke all on function public\.v3_tenant_odeiry_snapshot\(text\)[\s\S]+?from public,anon,authenticated,service_role;/
  );
  assert.match(
    sql,
    /grant execute on function public\.v3_tenant_odeiry_snapshot\(text\)\s+to authenticated;/
  );
});
