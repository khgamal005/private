import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('employee profile manages Yeastar extensions through the existing mapping',async()=>{
  const [sql,gate,component,route,page,helper]=await Promise.all([
    read('supabase/migrations/20260802235000_employee_yeastar_extensions_v1.sql'),
    read('supabase/migrations/20260802235500_gate_yeastar_employee_extension_by_addon_v1.sql'),
    read('components/team-directory.js'),
    read('app/api/tenant/staff-extension/route.js'),
    read('app/tenant/[slug]/team/page.js'),
    read('lib/achievement.js')
  ]);
  assert.match(sql,/v2_tenant_staff_extension_snapshot/);
  assert.match(sql,/v2_tenant_assign_staff_extension/);
  assert.match(sql,/extensionAssignments/);
  assert.match(sql,/tenant\.people\.manage/);
  assert.match(sql,/yeastar_extension_already_assigned/);
  assert.match(sql,/array_to_string\(v_extensions, ', '\)/);

  assert.match(gate,/addon\.integration\.yeastar/);
  assert.match(gate,/private_app\.tenant_addon_installed/);
  assert.match(gate,/subscription\.status in \('trialing', 'active'\)/);
  assert.match(gate,/yeastar_addon_not_enabled/);
  assert.match(gate,/'enabled', v_enabled/);

  assert.match(component,/const yeastarEnabled=Boolean\(staffExtensions\?\.enabled\)/);
  assert.match(component,/yeastarEnabled&&<label className="mt-field">/);
  assert.match(component,/yeastarEnabled&&<div>/);
  assert.match(component,/if\(staffId&&yeastarConfigured\)/);
  assert.match(component,/name="yeastar_extension"/);
  assert.match(component,/\/api\/tenant\/staff-extension/);
  assert.doesNotMatch(component,/سيظهر حقل التحويلة داخل بيانات الموظف/);

  assert.match(route,/v2_tenant_assign_staff_extension/);
  assert.match(route,/yeastar_addon_not_enabled/);
  assert.match(page,/enabled:false/);
  assert.match(page,/getTenantStaffExtensions/);
  assert.match(helper,/v2_tenant_staff_extension_snapshot/);
});
