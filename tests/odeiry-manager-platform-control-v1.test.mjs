import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('platform snapshot is read-only, permission bounded, and defaults tenants off',async()=>{
  const sql=await read(
    'supabase/migrations/20260831120000_odeiry_manager_platform_control_v1.sql'
  );
  assert.match(sql,/v1_platform_odeiry_manager_snapshot\(\)/);
  assert.match(sql,/platform\.tenants\.manage/);
  assert.match(sql,/platform\.settings\.manage/);
  assert.match(sql,/left join core\.odeiry_manager_settings/);
  assert.match(sql,/'enabled',coalesce\(setting\.enabled,false\)/);
  assert.match(sql,/'version',coalesce\(setting\.version,0\)/);
  assert.match(sql,/revoke all on function[\s\S]+from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function[\s\S]+to authenticated/);
  assert.doesNotMatch(sql,/insert into core\.odeiry_manager_settings/);
  assert.doesNotMatch(sql,/update core\.odeiry_manager_settings/);
});

test('platform data loader merges authoritative manager state by tenant id',async()=>{
  const source=await read('lib/platform-api.js');
  assert.match(source,/v1_platform_odeiry_manager_snapshot/);
  assert.match(source,/odeiryByTenant\.get\(tenant\.id\)/);
  assert.match(source,/version:Number\(manager\.version\)\|\|0/);
  assert.match(source,/canManage:Boolean\(odeiryManager\.canManage\)/);
});

test('platform API exposes only the existing audited configure RPC',async()=>{
  const source=await read('app/api/platform/[action]/route.js');
  assert.match(
    source,
    /'configure-odeiry-manager':'v1_platform_odeiry_manager_configure'/
  );
  assert.match(source,/odeiry_manager_version_conflict/);
  assert.doesNotMatch(source,/service_role/);
});

test('tenant UI confirms changes and sends optimistic version',async()=>{
  const source=await read('components/platform-tenants.js');
  assert.match(source,/أوديري المدير/);
  assert.match(source,/setOdeiryConfirmation/);
  assert.match(source,/expectedVersion:current\.version/);
  assert.match(source,/aria-pressed=\{manager\.enabled\}/);
  assert.match(source,/!odeiryControl\.canManage\|\|managerBusy/);
  assert.match(source,/لن ينفذ أوديري أي تعديل على بيانات المنشأة/);
  assert.match(
    source,
    /effectiveEnabled:Boolean\(updated\.effectiveEnabled\)/
  );
  assert.doesNotMatch(
    source,
    /effectiveEnabled:Boolean\(\s*odeiryControl\.globalEnabled&&updated\.enabled/
  );
});
