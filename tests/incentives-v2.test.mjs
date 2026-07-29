import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('goals and incentives use a tenant-safe ledger and real registration sources',async()=>{
  const migration=await read('../supabase/migrations/20260729213000_goals_incentives_v2.sql');
  assert.match(migration,/create schema if not exists incentives_core/);
  assert.match(migration,/create table incentives_core\.plans/);
  assert.match(migration,/create table incentives_core\.assignments/);
  assert.match(migration,/create table incentives_core\.events/);
  assert.match(migration,/registration_handoff_incentives_v2/);
  assert.match(migration,/sales_core\.contacts/);
  assert.match(migration,/owner_staff_id/);
  assert.match(migration,/payment_status = 'verified'/);
  assert.match(migration,/cancellation_window_days/);
  for(const state of ['expected','pending','due','approved','paid','cancelled','refunded']){
    assert.match(migration,new RegExp(`'${state}'`));
  }
  assert.match(migration,/v2_tenant_incentives_snapshot/);
  assert.match(migration,/v2_tenant_incentives_action/);
  assert.match(migration,/private_app\.has_tenant_permission/);
  assert.match(migration,/revoke all on all tables in schema incentives_core/);
  assert.doesNotMatch(migration,/service_role|SUPABASE_SECRET/i);
});

test('the incentives UX includes slabs, approvals, payment, and role-scoped views',async()=>{
  const workspace=await read('../components/engagement-workspace.js');
  const api=await read('../app/api/engagement/[action]/route.js');
  const styles=await read('../components/incentive-workspace.module.css');
  const feedbackStyles=await read('../app/action-feedback.css');

  assert.match(workspace,/الأهداف والحوافز/);
  assert.match(workspace,/متوقع ← معلّق ← مستحق ← معتمد ← مدفوع/);
  assert.match(workspace,/شرائح الحوافز/);
  assert.match(workspace,/شرط الاستحقاق/);
  assert.match(workspace,/تأكيد الصرف/);
  assert.match(workspace,/viewer\.canApprove/);
  assert.match(workspace,/viewer\.canPay/);
  assert.match(workspace,/مزامنة النتائج/);
  assert.match(api,/v2_tenant_incentives_snapshot/);
  assert.match(api,/v2_tenant_incentives_action/);
  assert.match(styles,/grid-template-columns:repeat\(6/);
  assert.match(workspace,/planError/);
  assert.match(workspace,/اختيار الفريق وتوزيع الأهداف/);
  assert.match(styles,/\.planModal\{[^}]*overflow:hidden/);
  assert.match(styles,/\.employeePicker\{[^}]*overflow:visible/);
  assert.match(feedbackStyles,/\.mt-system-feedback\.error\{[^}]*min-height:0/);
});

test('course labels use the actual academy course title column',async()=>{
  const migration=await read('../supabase/migrations/20260729213000_goals_incentives_v2.sql');
  const historyMarker=await read('../supabase/migrations/20260729191730_fix_incentive_course_title.sql');
  assert.match(migration,/select c\.title_ar into v_course_name/);
  assert.doesNotMatch(migration,/select c\.name into v_course_name/);
  assert.match(historyMarker,/Historical preview migration marker/);
  assert.doesNotMatch(historyMarker,/incentives_core\./);
});
