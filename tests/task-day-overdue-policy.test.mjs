import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  businessDateKey,
  isCompletedLateByDay,
  isCustomerFollowupTask,
  isPastBusinessDay,
  isSameBusinessDay,
  isTaskOverdue
} from '../lib/task-timing.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const RIYADH='Asia/Riyadh';

test('the selected hour never makes a task overdue during its due day',()=>{
  const dueAt='2026-08-22T06:00:00.000Z'; // 09:00 Riyadh
  const lateSameDay='2026-08-22T20:59:59.000Z'; // 23:59 Riyadh

  assert.equal(isPastBusinessDay(dueAt,{
    now:new Date(lateSameDay),
    timeZone:RIYADH
  }),false);
  assert.equal(isSameBusinessDay(dueAt,lateSameDay,RIYADH),true);
});

test('a task becomes overdue at the start of the next tenant-local day',()=>{
  const dueAt='2026-08-22T06:00:00.000Z';
  const nextDay='2026-08-22T21:00:00.000Z'; // 00:00 Riyadh, Aug 23

  assert.equal(isPastBusinessDay(dueAt,{
    now:new Date(nextDay),
    timeZone:RIYADH
  }),true);
  assert.equal(businessDateKey(nextDay,RIYADH),'2026-08-23');
});

test('completion timing is measured by local date rather than selected hour',()=>{
  const dueAt='2026-08-22T06:00:00.000Z';

  assert.equal(isCompletedLateByDay(
    '2026-08-22T18:00:00.000Z',
    dueAt,
    RIYADH
  ),false);
  assert.equal(isCompletedLateByDay(
    '2026-08-22T21:01:00.000Z',
    dueAt,
    RIYADH
  ),true);
});

test('the day policy is limited to customer follow-up tasks',()=>{
  const now=new Date('2026-08-22T18:00:00.000Z');
  const dueAt='2026-08-22T06:00:00.000Z';
  const followup={dueAt,contactId:'customer-1',taskSource:'sales_followup'};
  const operational={dueAt,taskSource:'manual'};

  assert.equal(isCustomerFollowupTask(followup),true);
  assert.equal(isTaskOverdue(followup,{now,timeZone:RIYADH}),false);
  assert.equal(isCustomerFollowupTask(operational),false);
  assert.equal(isTaskOverdue(operational,{now,timeZone:RIYADH}),true);
});

test('calendar, sales, dashboards, history and RPCs use the day policy',async()=>{
  const [
    migration,
    salesMigration,
    calendar,
    sales,
    followup,
    dashboard,
    api,
    platformApi,
    achievement,
    calendarApi,
    historyRoute
  ]=await Promise.all([
    read('supabase/migrations/20260822050000_task_day_overdue_policy_v1.sql'),
    read('supabase/migrations/20260825144111_tenant_sales_workspace_resilience_v1.sql'),
    read('components/task-calendar-page.js'),
    read('components/sales-workspace.js'),
    read('components/sales-followup-modal.js'),
    read('components/role-dashboard.js'),
    read('lib/api.js'),
    read('lib/platform-api.js'),
    read('lib/achievement.js'),
    read('app/api/tenant/[action]/route.js'),
    read('app/api/tenant/customer-history/route.js')
  ]);

  assert.match(migration,/task_day_is_overdue_v1/);
  assert.match(migration,/customer_followup_uses_day_policy_v1/);
  assert.match(migration,/zz_enforce_task_day_timing_before_write/);
  assert.match(migration,/v3_tenant_update_task_status/);
  assert.match(migration,/v4_tenant_transition_task/);
  assert.match(migration,/task\.due_at < v_today_start/);
  assert.match(migration,/v4_tenant_operations_snapshot/);
  assert.match(migration,/v3_platform_control_snapshot/);
  assert.match(migration,/v4_tenant_sales_pipeline_snapshot/);
  assert.match(migration,/v2_tenant_dashboard_live_snapshot/);
  assert.match(migration,/v6_tenant_calendar_day_snapshot/);
  assert.match(migration,/v2_tenant_role_dashboard_snapshot_v8/);
  assert.match(migration,/v2_tenant_employee_achievement_snapshot_v3/);
  assert.match(migration,/v4_tenant_customer_history_snapshot/);
  assert.match(migration,/v5_tenant_reports_snapshot/);
  assert.doesNotMatch(migration,/delete\s+from\s+work_core\.tasks/i);

  assert.match(calendar,/isTaskOverdue/);
  assert.doesNotMatch(
    calendar,
    /new Date\(task\.dueAt\)<new Date\(\)/
  );
  assert.match(salesMigration,/v_filter = 'overdue'/);
  assert.match(
    salesMigration,
    /contact\.next_action_at at time zone v_timezone[\s\S]{0,80}\)::date < v_today/
  );
  assert.doesNotMatch(sales,/isPastBusinessDay/);
  assert.doesNotMatch(
    sales,
    /new Date\(contact\.nextActionAt\)<new Date\(\)/
  );
  assert.match(dashboard,/isTaskOverdue/);
  assert.match(followup,/الساعة للتنظيم والترتيب فقط/);

  assert.match(api,/v2_tenant_dashboard_live_snapshot/);
  assert.match(api,/v4_tenant_operations_snapshot/);
  assert.match(api,/v4_tenant_sales_pipeline_snapshot/);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v8/);
  assert.match(api,/v5_tenant_reports_snapshot/);
  assert.match(platformApi,/v3_platform_control_snapshot/);
  assert.match(achievement,/v2_tenant_employee_achievement_snapshot_v3/);
  assert.match(calendarApi,/v3_tenant_update_task_status/);
  assert.match(calendarApi,/v4_tenant_transition_task/);
  assert.match(calendarApi,/v6_tenant_calendar_day_snapshot/);
  assert.match(historyRoute,/v5_tenant_customer_history_snapshot/);
});
