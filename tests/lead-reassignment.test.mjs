import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260812235107_lead_reassignment_permissions_audit_v1.sql';
const exportMigrationPath=
  'supabase/migrations/20260813000924_lead_assignment_export_search_v1.sql';
const customerModalMigrationPath=
  'supabase/migrations/20260813003628_customer_modal_reassignment_v1.sql';

test('data officers can see every distribution screen and authorized roles can reassign',async()=>{
  const [migration,api]=await Promise.all([
    read(migrationPath),
    read('lib/api.js')
  ]);

  assert.match(migration,/role\.role_key = 'data_officer'[\s\S]+tenant\.leads\.distribute/);
  for(const role of ['sales_supervisor','data_officer']){
    assert.match(migration,new RegExp(`'${role}'`));
  }
  assert.match(migration,/tenant\.leads\.reassign/);
  assert.match(migration,/private_app\.has_tenant_permission\([\s\S]+tenant\.leads\.reassign/);
  assert.match(api,/v1_tenant_lead_reassignment_snapshot/);
  assert.match(api,/canReassign:false/);
  assert.match(api,/isDataOfficer:false/);
  assert.match(
    await read('components/lead-intake-workspace.js'),
    /viewer\.canAnalytics\|\|viewer\.isDataOfficer/
  );
});

test('distribution log searches the complete tenant history by name or phone',async()=>{
  const [component,migration,exportMigration,route]=await Promise.all([
    read('components/lead-intake-workspace.js'),
    read(migrationPath),
    read(exportMigrationPath),
    read('app/api/tenant/[action]/route.js')
  ]);

  assert.match(component,/ابحث مباشرة باسم العميل أو رقم الهاتف/);
  assert.match(component,/\/api\/tenant\/lead-assignment-search/);
  assert.match(component,/p_query:search/);
  assert.match(component,/جارٍ البحث في كامل السجل/);
  assert.match(route,/'lead-assignment-search':'v1_tenant_lead_assignment_search'/);
  assert.match(migration,/v1_tenant_lead_assignment_search/);
  assert.match(migration,/lower\(contact\.full_name\) like/);
  assert.match(migration,/regexp_replace\([\s\S]+contact\.phone/);
  assert.match(migration,/assignment\.tenant_id = v_tenant\.id/);
  assert.match(migration,/limit v_limit/);
  assert.match(component,/tab==='assignments'[\s\S]+assignmentQuery\.trim\(\)/);
  assert.match(exportMigration,/v3_tenant_lead_intake_export_v1/);
  assert.match(exportMigration,/v_query text := nullif\(lower\(trim\(p_query\)\)/);
  assert.match(exportMigration,/lower\(event\.contact_name\) like/);
  assert.match(exportMigration,/regexp_replace\([\s\S]+event\.phone/);
});

test('reassignment is atomic, current-only, and transfers customer work',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/pg_advisory_xact_lock/);
  assert.match(migration,/jsonb_array_length\(p_payload -> 'assignmentIds'\) > 100/);
  assert.match(migration,/assignment\.status = 'active'/);
  assert.match(migration,/for update/);
  assert.match(migration,/set status = 'reassigned'/);
  assert.match(migration,/insert into sales_core\.lead_assignments/);
  assert.match(migration,/'previousAssignmentId'/);
  assert.match(migration,/update sales_core\.contacts[\s\S]+owner_staff_id = v_target_staff\.id/);
  assert.match(migration,/update sales_core\.opportunities[\s\S]+owner_staff_id = v_target_staff\.id/);
  assert.match(migration,/update work_core\.tasks[\s\S]+assigned_staff_id = v_target_staff\.id/);
  assert.match(migration,/lead_reassignment_reason_required/);
  assert.match(migration,/invalid_distribution_deadline/);
});

test('reassignment notifies affected staff and management and appears in customer history',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/insert into work_core\.notifications/);
  assert.match(migration,/'previous'::text as recipient_kind/);
  assert.match(migration,/'new'::text/);
  assert.match(migration,/'management'::text/);
  assert.match(migration,/tenant_owner/);
  assert.match(migration,/sales_manager/);
  assert.match(migration,/insert into sales_core\.activities/);
  assert.match(migration,/'lead_reassignment_audit'/);
  assert.match(migration,/تغيير إسناد العميل من/);
  assert.match(migration,/new\.metadata ->> 'source' = 'lead_reassignment_audit'/);
  assert.match(migration,/private_app\.write_audit/);
  assert.match(migration,/'tenant\.lead_reassigned'/);
});

test('sales supervisors and data officers get a reasoned bulk reassignment control',async()=>{
  const [component,route]=await Promise.all([
    read('components/lead-intake-workspace.js'),
    read('app/api/tenant/[action]/route.js')
  ]);

  assert.match(component,/viewer\.canReassign/);
  assert.match(component,/selectedAssignments/);
  assert.match(component,/تغيير إسناد المحدد/);
  assert.match(component,/سبب تغيير الإسناد/);
  assert.match(component,/موعد المتابعة الجديد/);
  assert.match(component,/\/api\/tenant\/lead-reassignment/);
  assert.match(component,/إرسال الإشعارات/);
  assert.match(route,/'lead-reassignment':'v1_tenant_lead_reassignment_action'/);
  assert.match(route,/lead_assignment_not_active/);
  assert.match(route,/same_sales_assignee/);
});

test('authorized users can reassign one customer directly from the customer modal',async()=>{
  const [modal,sales,api,migration]=await Promise.all([
    read('components/customer-edit-modal.js'),
    read('components/sales-workspace.js'),
    read('lib/api.js'),
    read(customerModalMigrationPath)
  ]);

  assert.match(modal,/تغيير إسناد العميل/);
  assert.match(modal,/مسؤول المبيعات الجديد/);
  assert.match(modal,/موعد المتابعة الجديد/);
  assert.match(modal,/سبب تغيير الإسناد/);
  assert.match(modal,/assignmentIds:\[contact\.activeAssignmentId\]/);
  assert.match(modal,/\/api\/tenant\/lead-reassignment/);
  assert.match(modal,/إرسال الإشعارات/);
  assert.match(modal,/canEdit=true/);
  assert.match(sales,/canReassign=\{canReassign\}/);
  assert.match(sales,/staff=\{staff\}/);
  assert.match(sales,/canWrite\|\|canReassign/);
  assert.match(api,/activeAssignmentsByContact/);
  assert.match(api,/activeAssignmentId:assignment\?\.assignmentId\|\|null/);
  assert.match(migration,/'activeAssignments', v_active_assignments/);
  assert.match(migration,/assignment\.tenant_id = v_tenant_id/);
  assert.match(migration,/assignment\.status = 'active'/);
  assert.match(migration,/if v_can_reassign then/);
});
