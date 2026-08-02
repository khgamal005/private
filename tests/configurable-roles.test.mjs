import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('admissions is a first-class role and not a department workaround',async()=>{
  const [catalog,migration,layout]=await Promise.all([
    read('supabase/migrations/20260802241000_admissions_role_and_permissions_v1.sql'),
    read('supabase/migrations/20260802241400_migrate_reef_admissions_officer_v1.sql'),
    read('app/tenant/[slug]/layout.js')
  ]);
  assert.match(catalog,/admissions_officer/);
  assert.match(catalog,/مسؤول التسجيل والقبول/);
  assert.match(catalog,/tenant\.admissions\.read/);
  assert.match(catalog,/tenant\.admissions\.write/);
  assert.match(migration,/staff\.full_name = 'داليا'/);
  assert.match(migration,/role_key = 'admissions_officer'/);
  assert.match(layout,/admissions_officer:'مسؤول التسجيل والقبول'/);
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

test('navigation and reports are permission-driven for old and new roles',async()=>{
  const [scopes,policy,layout,callReports]=await Promise.all([
    read('supabase/migrations/20260802241300_permission_driven_reporting_scopes_v1.sql'),
    read('lib/tenant-role-policy.js'),
    read('app/tenant/[slug]/layout.js'),
    read('app/tenant/[slug]/call-reports/page.js')
  ]);
  assert.match(scopes,/tenant\.reports\.team/);
  assert.match(scopes,/tenant\.reports\.campaigns/);
  assert.match(scopes,/v_personal_only := not v_view_team/);
  assert.match(scopes,/v2_tenant_yeastar_reports_snapshot_v3/);
  assert.match(policy,/navigationPolicyRoleKey/);
  assert.match(policy,/tenant\.people\.read/);
  assert.match(policy,/tenant\.reports\.team/);
  assert.match(policy,/tenant\.reports\.campaigns/);
  assert.match(layout,/roleKey=\{navigationRoleKey\}/);
  assert.match(callReports,/v2_tenant_yeastar_reports_snapshot_v3/);
});
