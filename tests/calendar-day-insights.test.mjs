import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260807014000_calendar_day_task_insights_v1.sql';

test('the hidden task count opens a complete daily details dialog',async()=>{
  const [calendar,styles]=await Promise.all([
    read('components/task-calendar-page.js'),
    read('components/task-calendar-day.module.css')
  ]);

  assert.match(calendar,/className=\{`more-tasks \$\{dayStyles\.moreButton\}`\}/);
  assert.match(calendar,/onClick=\{\(\)=>openDay\(day\)\}/);
  assert.match(calendar,/CalendarDayDetails/);
  assert.match(calendar,/role="dialog"/);
  assert.match(calendar,/aria-modal="true"/);
  assert.match(calendar,/إغلاق مهام العملاء/);
  assert.match(calendar,/دقائق Yeastar للمهام المنجزة/);
  assert.match(calendar,/تم إنجازه/);
  assert.match(calendar,/لم يكتمل/);
  assert.match(calendar,/ابحث باسم العميل أو المهمة أو الجوال/);
  assert.match(styles,/\.dialog\{/);
  assert.match(styles,/@media\(max-width:620px\)/);
  assert.match(styles,/@media\(prefers-reduced-motion:reduce\)/);
});

test('the daily dialog loads verified server metrics without guessed fallbacks',async()=>{
  const [calendar,api]=await Promise.all([
    read('components/task-calendar-page.js'),
    read('app/api/tenant/[action]/route.js')
  ]);

  assert.match(calendar,/call\('calendar-day'/);
  assert.match(calendar,/p_task_ids:dayTasks\.map\(task=>task\.id\)/);
  assert.match(calendar,/لن نعرض أرقامًا تقريبية/);
  assert.match(calendar,/insight\?\.summary/);
  assert.match(calendar,/insight\?\.yeastar/);
  assert.match(api,/'calendar-day':'v5_tenant_calendar_day_snapshot'/);
  assert.match(api,/invalid_calendar_day/);
  assert.match(api,/too_many_calendar_tasks/);
});

test('large calendar days render a bounded page instead of every task at once',async()=>{
  const [calendar,styles]=await Promise.all([
    read('components/task-calendar-page.js'),
    read('components/task-calendar-day.module.css')
  ]);

  assert.match(calendar,/const DAY_TASK_PAGE_SIZE=30/);
  assert.match(calendar,/visibleTasks\.slice\(pageStart,pageStart\+DAY_TASK_PAGE_SIZE\)/);
  assert.match(calendar,/pageTasks\.map\(task=>/);
  assert.doesNotMatch(calendar,/visibleTasks\.map\(task=>/);
  assert.match(calendar,/صفحة \{number\(currentPage\)\} من \{number\(pageCount\)\}/);
  assert.match(calendar,/عرض \{number\(pageStart\+1\)\}–/);
  assert.match(styles,/\.pagination\{/);
  assert.match(styles,/\.taskList\{max-height:min\(50dvh,430px\)\}/);
  assert.doesNotMatch(styles,/\.taskList\{max-height:none\}/);
});

test('calendar metrics use canonical role scope and tenant-local day bounds',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/private_app\.v2_metric_staff_scope/);
  assert.match(sql,/task\.assigned_staff_id = any\(v_scope_staff_ids\)/);
  assert.match(sql,/staff\.supervisor_staff_id|v2_metric_staff_scope/);
  assert.match(sql,/p_day::timestamp at time zone v_tenant\.timezone/);
  assert.match(sql,/\(p_day \+ 1\)::timestamp at time zone v_tenant\.timezone/);
  assert.match(sql,/private_app\.v2_metric_is_open_task/);
  assert.match(sql,/customerCompletionRate/);
  assert.match(sql,/task\.status = 'completed'/);
  assert.match(sql,/task\.status <> 'cancelled'/);
});

test('Yeastar talk time is linked and de-duplicated against real customer tasks',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/private_app\.tenant_yeastar_addon_enabled/);
  assert.match(sql,/extensionAssignments/);
  assert.match(sql,/private_app\.normalize_lead_phone/);
  assert.match(sql,/task\.assigned_staff_id = call\.staff_id/);
  assert.match(sql,/task\.contact_phone_key = call\.external_phone_key/);
  assert.match(sql,/partition by call\.id/);
  assert.match(sql,/where match\.task_rank = 1/);
  assert.match(sql,/count\(distinct call\.id\)/);
  assert.match(sql,/sum\(call\.handling_duration_seconds\)/);
  assert.match(sql,/call\.final_status = 'ANSWERED'/);
  assert.match(sql,/matchedCompletedTasks/);
  assert.match(sql,/yeastarTalkSeconds/);
});

test('the calendar day RPC is permission checked and exposed only to authenticated users',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/tenant\.work\.read/);
  assert.match(sql,/tenant\.crm\.read/);
  assert.match(sql,/security definer/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/revoke all on function[\s\S]+from public, anon/);
  assert.match(sql,/grant execute on function[\s\S]+to authenticated/);
  assert.doesNotMatch(sql,/service_role|SUPABASE_SECRET/i);
});
