import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migration=await readFile(
  new URL(
    '../supabase/migrations/20260806223000_fix_yeastar_owner_report_scope_v1.sql',
    import.meta.url
  ),
  'utf8'
);

test('Yeastar tenant-wide viewers never inherit a nullable personal scope',()=>{
  assert.match(
    migration,
    /and coalesce\(\s*v_role_key in \([\s\S]*?'data_analyst'[\s\S]*?\),\s*false\s*\)/
  );
  assert.doesNotMatch(
    migration,
    /and v_role_key in \(\s*'sales_user'/
  );
});

test('personal Yeastar reports remain extension-scoped',()=>{
  assert.match(
    migration,
    /record\.involved_extensions && v_staff_extensions/
  );
  assert.match(
    migration,
    /p_extension = any\(v_staff_extensions\)/
  );
});

test('the private report core stays unavailable through the Data API',()=>{
  assert.match(
    migration,
    /revoke all on function private_app\.yeastar_reports_snapshot_core_v2\([\s\S]*?from public, anon, authenticated/
  );
});
