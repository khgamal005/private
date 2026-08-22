import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260808161625_move_sales_followup_task_v1.sql';
const lifecycleMigrationPath=
  'supabase/migrations/20260809163000_followup_task_single_calendar_record_v2.sql';
const allRolesLifecycleMigrationPath=
  'supabase/migrations/20260813123327_calendar_task_lifecycle_v3.sql';

test('an open customer follow-up moves the same task instead of inserting a duplicate',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/v_followup_task work_core\.tasks%rowtype/);
  assert.match(
    migration,
    /select task\.\*[\s\S]+into v_followup_task[\s\S]+for update;/
  );
  assert.match(
    migration,
    /if v_followup_task\.id is not null then[\s\S]+update work_core\.tasks[\s\S]+due_at = p_next_action_at[\s\S]+status = 'todo'/
  );
  assert.match(
    migration,
    /else[\s\S]+insert into work_core\.tasks[\s\S]+returning id into v_task_id;[\s\S]+end if;/
  );
  assert.match(migration,/'taskUpdated',[\s\S]+v_is_open and v_followup_task\.id is not null/);
  assert.match(migration,/'previousDueAt',[\s\S]+v_followup_task\.due_at/);
  assert.match(migration,/'nextDueAt',[\s\S]+p_next_action_at/);
});

test('customer actions remain immutable history with the previous planned time',async()=>{
  const migration=await read(migrationPath);

  assert.equal(
    (migration.match(/insert into sales_core\.activities/g)||[]).length,
    1
  );
  assert.match(migration,/'scheduledTaskId',[\s\S]+v_followup_task\.id/);
  assert.match(migration,/'scheduledAt',[\s\S]+v_followup_task\.due_at/);
  assert.match(
    migration,
    /activity\.metadata ->> 'scheduledAt'[\s\S]+resolvedByActivityId/
  );
  assert.match(
    migration,
    /v_contact\.lead_status is distinct from p_lead_status[\s\S]+insert into sales_core\.lead_status_history/
  );
});

test('legacy duplicate task chains are consolidated recoverably',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/audit_log\.followup_task_merge_archive/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/create temporary table followup_task_merge_plan/);
  assert.match(migration,/update sales_core\.activities activity/);
  assert.match(migration,/delete from work_core\.tasks task/);
  assert.match(migration,/'mergedTaskIds'/);
  assert.match(migration,/'taskMergeVersion', 'single_followup_task_v1'/);
});

test('calendar and follow-up dialogs show the exact latest customer note',async()=>{
  const [migration,api,calendar,followup,css]=await Promise.all([
    read(migrationPath),
    read('lib/api.js'),
    read('components/task-calendar-page.js'),
    read('components/sales-followup-modal.js'),
    read('app/globals.css')
  ]);

  assert.match(migration,/v3_tenant_sales_pipeline_snapshot/);
  assert.match(migration,/'latestNote'/);
  assert.match(migration,/order by activity\.occurred_at desc, activity\.id desc/);
  assert.match(api,/authRpc\('v4_tenant_sales_pipeline_snapshot'/);
  assert.match(api,/contactLatestNote:contact\.latestNote\|\|contact\.notes/);
  assert.match(calendar,/dayTasksById/);
  assert.match(calendar,/calendar-customer-latest-note/);
  assert.match(calendar,/آخر ملاحظة/);
  assert.match(followup,/آخر ملاحظة مسجلة/);
  assert.match(followup,/payload\.data\?\.taskUpdated/);
  assert.match(followup,/نقل مهمة المتابعة نفسها إلى الموعد الجديد/);
  assert.match(css,/\.mt-customer-summary>\.mt-customer-latest-note/);
});


test('the distributed lead task and sales follow-up are one calendar lifecycle',async()=>{
  const [migration,allRolesMigration,api,followup]=await Promise.all([
    read(lifecycleMigrationPath),
    read(allRolesLifecycleMigrationPath),
    read('app/api/tenant/[action]/route.js'),
    read('components/sales-followup-modal.js')
  ]);

  assert.match(migration,/'lead_assignment'/);
  assert.match(migration,/followup_task_merge_plan_v2/);
  assert.match(migration,/lead_assignment_followup_duplicate_v2/);
  assert.match(migration,/delete from work_core\.tasks task/);
  assert.match(migration,/work_tasks_one_open_sales_followup_idx/);
  assert.match(migration,/create or replace function public\.v2_tenant_record_sales_followup_v4/);
  assert.match(migration,/status = 'todo'[\s\S]+source', 'sales_followup'/);
  assert.match(migration,/due_at = p_next_action_at/);
  assert.match(migration,/status = 'completed'[\s\S]+resolvedByActivityId/);
  assert.match(allRolesMigration,/v2_tenant_record_sales_followup_v5/);
  assert.match(allRolesMigration,/p_task_id uuid default null/);
  assert.match(allRolesMigration,/v_result_task_id is distinct from p_task_id/);
  assert.match(api,/record-sales-followup':'v2_tenant_record_sales_followup_v5/);
  assert.match(followup,/p_task_id:task\?\.id\|\|null/);
  assert.match(followup,/دون إنشاء مهمة مكررة/);
});
