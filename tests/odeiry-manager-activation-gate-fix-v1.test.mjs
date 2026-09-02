import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

const migrationPath=
  'supabase/migrations/20260902120000_odeiry_manager_activation_gate_fix_v1.sql';

test('manager enable repairs the base gate atomically and idempotently',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/^begin;/);
  assert.match(sql,/commit;\s*$/);
  assert.match(sql,/platform\.settings\.manage/);
  assert.match(sql,/odeiry_manager_version_conflict/);
  assert.match(sql,/odeir:odeiry-manager:config:/);
  assert.match(sql,/odeir:odeiry:tenant-config:/);
  assert.match(sql,/if v_enabled then[\s\S]+?insert into core\.odeiry_tenant_settings/);
  assert.match(sql,/elsif not v_base_setting\.enabled then[\s\S]+?update core\.odeiry_tenant_settings/);
  assert.match(sql,/'autoEnabledBy','odeiry_manager'/);
  assert.match(sql,/'baseAutoEnabled',v_base_changed/);
});

test('manager disable does not silently disable the independent base assistant',async()=>{
  const sql=await read(migrationPath);
  const disableBranch=sql.match(
    /else\s+select setting\.\* into v_base_setting[\s\S]+?end if;/
  )?.[0]||'';
  assert.ok(disableBranch);
  assert.doesNotMatch(disableBranch,/update core\.odeiry_tenant_settings/);
});

test('platform snapshot includes the authoritative base gate',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/left join core\.odeiry_tenant_settings base_setting/);
  assert.match(sql,/'baseEnabled',coalesce\(base_setting\.enabled,false\)/);
  assert.match(sql,/'baseAvailable',private_app\.odeiry_is_available\(tenant\.id\)/);
  assert.match(
    sql,
    /'effectiveEnabled',\([\s\S]+?v_runtime\.manager_enabled[\s\S]+?manager_setting\.enabled[\s\S]+?private_app\.odeiry_is_available\(tenant\.id\)/
  );
});

test('the public RPCs remain permission-bounded',async()=>{
  const sql=await read(migrationPath);
  assert.match(
    sql,
    /revoke all on function public\.v1_platform_odeiry_manager_configure\([\s\S]+?from public,anon,authenticated,service_role;[\s\S]+?grant execute[\s\S]+?to authenticated;/
  );
  assert.match(
    sql,
    /revoke all on function public\.v1_platform_odeiry_manager_snapshot\(\)[\s\S]+?from public,anon,authenticated,service_role;[\s\S]+?grant execute[\s\S]+?to authenticated;/
  );
});
