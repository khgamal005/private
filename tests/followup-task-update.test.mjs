import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260808161625_move_sales_followup_task_v1.sql';

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
  assert.match(api,/authRpc\('v3_tenant_sales_pipeline_snapshot'/);
  assert.match(api,/contactLatestNote:contact\.latestNote\|\|contact\.notes/);
  assert.match(calendar,/dayTasksById/);
  assert.match(calendar,/calendar-customer-latest-note/);
  assert.match(calendar,/آخر ملاحظة/);
  assert.match(followup,/آخر ملاحظة مسجلة/);
  assert.match(followup,/payload\.data\?\.taskUpdated/);
  assert.match(followup,/نقل مهمة المتابعة نفسها إلى الموعد الجديد/);
  assert.match(css,/\.mt-customer-summary>\.mt-customer-latest-note/);
});
