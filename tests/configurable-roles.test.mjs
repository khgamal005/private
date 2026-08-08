import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('admissions is a first-class permission area and role label',async()=>{
  const [admissions,layout,shell]=await Promise.all([
    read('supabase/migrations/20260727223000_admissions_and_sales_guards_v2.sql'),
    read('app/tenant/[slug]/layout.js'),
    read('components/workspace-shell.js')
  ]);
  assert.match(admissions,/tenant\.admissions\.read/);
  assert.match(admissions,/tenant\.admissions\.write/);
  assert.match(admissions,/عرض التسجيل والقبول/);
  assert.match(layout,/admissions_officer:'مسؤول التسجيل والقبول'/);
  assert.match(shell,/tenant\.admissions\.read/);
});

test('tenant roles can be created and configured centrally',async()=>{
  const [snapshots,actions,settings,manager,route,api]=await Promise.all([
    read('supabase/migrations/20260802241100_tenant_role_management_snapshots_v1.sql'),
    read('supabase/migrations/20260802241200_tenant_role_management_actions_v1.sql'),
    read('components/tenant-settings.js'),
    read('components/role-permissions-manager.js'),
    read('app/api/tenant/roles/route.js'),
    read('lib/api.js')
  ]);
  assert.match(snapshots,/v2_tenant_role_management_snapshot/);
  assert.match(snapshots,/v2_tenant_effective_roles_snapshot/);
  assert.match(actions,/p_action = 'create_role'/);
  assert.match(actions,/p_action = 'update_role'/);
  assert.match(actions,/p_action = 'reset_role'/);
  assert.match(actions,/p_action = 'delete_role'/);
  assert.match(actions,/cannot_remove_own_role_management/);
  assert.match(actions,/private_app\.write_audit/);
  assert.match(settings,/RolePermissionsManager/);
  assert.match(manager,/\+ إضافة دور/);
  assert.match(manager,/اختر صلاحيات الدور/);
  assert.match(route,/v2_tenant_role_management_action/);
  assert.match(api,/v2_tenant_role_management_snapshot/);
  assert.match(api,/v2_tenant_effective_roles_snapshot/);
});

test('navigation and operational reports are permission-driven',async()=>{
  const [scopes,policy,layout,callReports]=await Promise.all([
    read('supabase/migrations/20260802233000_operational_role_visibility_and_personal_reports.sql'),
    read('lib/tenant-role-policy.js'),
    read('app/tenant/[slug]/layout.js'),
    read('app/tenant/[slug]/yeastar/page.js')
  ]);
  assert.match(scopes,/v_personal_only boolean/);
  assert.match(scopes,/p_report = 'campaigns' and not v_campaign_allowed/);
  assert.match(scopes,/v2_tenant_yeastar_reports_snapshot_v2/);
  assert.match(policy,/navigationPolicyRoleKey/);
  assert.match(policy,/tenant\.people\.read/);
  assert.match(policy,/tenant\.reports\.team/);
  assert.match(policy,/tenant\.reports\.campaigns/);
  assert.match(layout,/roleKey=\{navigationRoleKey\}/);
  assert.match(callReports,/v3_tenant_yeastar_reports_snapshot/);
});
