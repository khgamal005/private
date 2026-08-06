import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260806213000_unify_employee_performance_metrics_v1.sql';

test('employee metrics share explicit task and customer definitions',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/v2_metric_is_open_task/);
  assert.match(sql,/in \('todo', 'in_progress'\)/);
  assert.match(sql,/v2_metric_is_countable_contact/);
  assert.match(sql,/<> 'archived'/);
  assert.match(sql,/<> 'duplicate'/);
  assert.match(sql,/v2_metric_is_active_contact/);
  for(const status of [
    'new',
    'no_answer',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'payment_submitted'
  ]){
    assert.match(sql,new RegExp(`'${status}'`));
  }

  assert.doesNotMatch(sql,/status <> 'completed'/);
  assert.doesNotMatch(sql,/lead_status = 'paid'/);
});

test('employee metrics use tenant-local periods and verified payments',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/now\(\) at time zone v_timezone/);
  assert.match(sql,/v_day_start/);
  assert.match(sql,/v_month_start/);
  assert.match(sql,/handoff\.payment_status = 'verified'/);
  assert.match(sql,/registration_handoffs_verified_paid_idx/);
  assert.match(sql,/where payment_status = 'verified'/);
  assert.doesNotMatch(sql,/date_trunc\('day', now\(\)\)/);
  assert.doesNotMatch(sql,/date_trunc\('month', now\(\)\)/);
});

test('supervisors are limited to self and direct reports in every snapshot',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/staff\.supervisor_staff_id = p_viewer_staff_id/);
  assert.match(sql,/staff\.id = any\(v_scope_staff_ids\)/);
  assert.match(sql,/contact\.owner_staff_id = any\(v_scope_staff_ids\)/);
  assert.match(sql,/assignment\.assigned_staff_id = any\(v_scope_staff_ids\)/);
  assert.match(sql,/mapping\.value = any\(v_scope_staff_text\)/);
  assert.match(sql,/v2_tenant_reports_snapshot_v3/);
  assert.match(sql,/v2_tenant_role_dashboard_snapshot_v3/);
  assert.match(sql,/v2_tenant_employee_achievement_snapshot_v2/);
});

test('metric RPCs are hardened and stale client fallbacks are disabled',async()=>{
  const [sql,api,achievement,page,dashboard]=await Promise.all([
    read(migrationPath),
    read('lib/api.js'),
    read('lib/achievement.js'),
    read('app/tenant/[slug]/page.js'),
    read('components/role-dashboard.js')
  ]);

  assert.match(sql,/security definer/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/from public, anon/);
  assert.match(sql,/to authenticated/);
  assert.doesNotMatch(sql,/service_role|SUPABASE_SECRET/i);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v3/);
  assert.match(api,/v2_tenant_reports_snapshot_v3/);
  assert.match(achievement,/v2_tenant_employee_achievement_snapshot_v2/);
  assert.match(page,/unavailable:true/);
  assert.doesNotMatch(page,/task\.status!=='completed'/);
  assert.match(dashboard,/OPEN_TASK_STATUSES\.has\(task\.status\)/);
  assert.match(dashboard,/لم نعرض أرقامًا بديلة/);
});
