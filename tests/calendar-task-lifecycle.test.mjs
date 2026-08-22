import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260813123327_calendar_task_lifecycle_v3.sql';
const hardeningMigrationPath=
  'supabase/migrations/20260813123957_calendar_task_history_hardening_v1.sql';

test('every department uses one mutable task row with append-only history',async()=>{
  const [migration,hardening]=await Promise.all([
    read(migrationPath),
    read(hardeningMigrationPath)
  ]);

  assert.match(migration,/create table if not exists work_core\.task_history/);
  assert.match(migration,/alter table work_core\.task_history enable row level security/);
  assert.match(migration,/revoke all on table work_core\.task_history[\s\S]+authenticated/);
  assert.match(migration,/create trigger capture_task_history_after_update/);
  assert.match(migration,/after update of[\s\S]+status[\s\S]+due_at[\s\S]+assigned_staff_id/);
  assert.match(migration,/private_app\.current_subject_id\(\)/);
  assert.match(migration,/event_type in \('rescheduled', 'status_changed', 'reassigned', 'updated'\)/);
  assert.match(hardening,/create policy task_history_service_read/);
  assert.match(hardening,/to service_role/);
  assert.match(hardening,/work_task_history_contact_reference_idx/);
  assert.match(hardening,/work_task_history_opportunity_reference_idx/);
  assert.match(hardening,/work_task_history_actor_reference_idx/);
  assert.match(hardening,/work_task_history_previous_assignee_reference_idx/);
  assert.match(hardening,/work_task_history_next_assignee_reference_idx/);
});

test('the general task transition locks and updates the selected id without inserting',async()=>{
  const migration=await read(migrationPath);
  const body=migration.match(
    /create or replace function public\.v3_tenant_transition_task[\s\S]+?\n\$\$;\n/
  )?.[0]||'';

  assert.match(body,/tenant\.work\.write/);
  assert.match(body,/where task\.id = p_task_id[\s\S]+for update/);
  assert.match(body,/update work_core\.tasks[\s\S]+where id = v_task\.id/);
  assert.match(body,/'taskUpdateMode', 'same_task_row_v3'/);
  assert.match(body,/v_task\.assigned_staff_id is distinct from v_current_staff_id/);
  assert.doesNotMatch(body,/insert into work_core\.tasks/);
  assert.doesNotMatch(body,/role_key/);
});

test('calendar customer actions bind the exact open follow-up task id',async()=>{
  const [migration,route,calendar,followup]=await Promise.all([
    read(migrationPath),
    read('app/api/tenant/[action]/route.js'),
    read('components/task-calendar-page.js'),
    read('components/sales-followup-modal.js')
  ]);

  assert.match(migration,/v2_tenant_record_sales_followup_v5/);
  assert.match(migration,/p_task_id uuid default null/);
  assert.match(migration,/v_result_task_id is distinct from p_task_id/);
  assert.match(route,/'record-sales-followup':'v2_tenant_record_sales_followup_v5'/);
  assert.match(route,/'transition-task':'v4_tenant_transition_task'/);
  assert.match(calendar,/SALES_TASK_SOURCES\.has\(task\.taskSource\)/);
  assert.match(calendar,/call\('transition-task'/);
  assert.match(calendar,/p_task_id:task\.id/);
  assert.match(followup,/p_task_id:task\?\.id\|\|null/);
});

test('old dates stay in customer history and not as a second calendar card',async()=>{
  const [migration,api,historyRoute,calendar,css]=await Promise.all([
    read(migrationPath),
    read('lib/api.js'),
    read('app/api/tenant/customer-history/route.js'),
    read('components/task-calendar-page.js'),
    read('app/globals.css')
  ]);

  assert.match(migration,/create or replace function public\.v3_tenant_operations_snapshot/);
  assert.match(migration,/task\.status <> 'cancelled'/);
  assert.match(migration,/task\.status = 'completed'[\s\S]+exists \(/);
  assert.match(migration,/'taskSource'/);
  assert.match(migration,/create or replace function public\.v3_tenant_customer_history_snapshot/);
  assert.match(migration,/'task-history:' \|\| history\.id::text/);
  assert.match(migration,/'previousDueAt', history\.previous_due_at/);
  assert.match(migration,/'nextDueAt', history\.next_due_at/);
  assert.match(api,/authRpc\('v4_tenant_operations_snapshot'/);
  assert.match(historyRoute,/v4_tenant_customer_history_snapshot/);
  assert.match(calendar,/تم نقل المهمة نفسها إلى الموعد الجديد/);
  assert.match(css,/\.calendar-task-transition/);
});
