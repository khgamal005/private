import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const migrationUrl=new URL(
  '../supabase/migrations/20260804202500_platform_owner_role_guard_v1.sql',
  import.meta.url
);

test('platform owner role cannot be changed by delegated access managers',async()=>{
  const migration=await readFile(migrationUrl,'utf8');
  assert.match(migration,/guard_platform_owner_role_update/);
  assert.match(migration,/old\.role_key='platform_owner'/);
  assert.match(migration,/subject\.auth_user_id=auth\.uid\(\)/);
  assert.match(migration,/role\.role_key='platform_owner'/);
  assert.match(migration,/raise exception 'owner_assignment_forbidden'/);
  assert.match(migration,/before update on access_control\.roles/);
  assert.match(
    migration,
    /revoke all on function private_app\.guard_platform_owner_role_update\(\)/
  );
});
