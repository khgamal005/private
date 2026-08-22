import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260822001947_sales_contact_task_lifecycle_v1.sql';

test('sales task page requests a server-scoped sales calendar',async()=>{
  const [page,api]=await Promise.all([
    read('app/tenant/[slug]/tasks/page.js'),
    read('lib/api.js')
  ]);

  assert.match(page,/taskScope[\s\S]{0,100}'sales'/);
  assert.match(page,/getTenantOperations\(slug,\{[\s\S]{0,120}taskScope/);
  assert.match(api,/getTenantOperations\(slug,\{[\s\S]{0,120}taskScope\s*=\s*'all'/);
  assert.match(api,/taskScope\s*===\s*'sales'/);

  for(const role of ['sales_manager','sales_supervisor','sales_user']){
    assert.match(api,new RegExp(`'${role}'`));
  }
  for(const source of [
    'lead_assignment',
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  ]){
    assert.match(api,new RegExp(`'${source}'`));
  }

  assert.match(
    api,
    /if\(task\.taskSource\s*===\s*'registration_handoff'\)return false/
  );
  assert.match(api,/SALES_TASK_SOURCES\.has\(task\.taskSource\)/);
  assert.match(
    api,
    /SALES_TASK_ROLE_KEYS\.has\([\s\S]{0,120}task\.assignedStaffId[\s\S]{0,80}roleKey/
  );
});

test('excellent quality stays overdue and has a clear badge in every calendar view',async()=>{
  const calendar=await read('components/task-calendar-page.js');
  const stateBody=calendar.match(
    /function state\(task,timeZone='UTC',now=new Date\(\)\)\{([\s\S]*?)\n\}/
  )?.[1]||'';

  assert.match(stateBody,/isTaskOverdue\(task,\{now,timeZone\}\)/);
  assert.doesNotMatch(stateBody,/excellent|contactQuality|leadQuality/);
  assert.match(calendar,/SalesQualityBadge/);

  const monthView=calendar.slice(
    calendar.indexOf('dayTasks.slice(0,4)'),
    calendar.indexOf('</>:<section className="role-calendar-agenda">')
  );
  const agendaView=calendar.slice(
    calendar.indexOf('<section className="role-calendar-agenda">'),
    calendar.indexOf('{showForm&&')
  );
  const dayRow=calendar.slice(
    calendar.indexOf('function DayTaskRow'),
    calendar.indexOf('function dayTaskStatusText')
  );

  for(const view of [monthView,agendaView,dayRow]){
    assert.match(view,/task\.contactQuality\s*===\s*'excellent'/);
    assert.match(
      view,
      /task\.contactQuality\s*===\s*'excellent'[\s\S]{0,180}SalesQualityBadge|SalesQualityBadge[\s\S]{0,180}task\.contactQuality\s*===\s*'excellent'/
    );
  }
});

test('unqualified quality and lead status stay synchronized in follow-up',async()=>{
  const followup=await read('components/sales-followup-modal.js');

  assert.match(
    followup,
    /const \[followupQuality,setFollowupQuality\]=useState\(/
  );
  assert.match(
    followup,
    /const initialQuality=contact\?\.leadQuality\|\|'unrated'/
  );
  assert.match(
    followup,
    /initialQuality\s*===\s*'unqualified'[\s\S]{0,160}'unqualified'/
  );
  assert.match(
    followup,
    /nextQuality\s*===\s*'unqualified'[\s\S]{0,180}setFollowupStatus\('unqualified'\)/
  );
  assert.match(
    followup,
    /OPEN_STATUSES\.has\(nextStatus\)[\s\S]{0,220}followupQuality\s*===\s*'unqualified'[\s\S]{0,180}setFollowupQuality\('unrated'\)/
  );
  assert.match(
    followup,
    /<QualitySelect[\s\S]{0,220}value=\{followupQuality\}/
  );
  assert.match(
    followup,
    /<StatusSelect[\s\S]{0,180}value=\{followupStatus\}[\s\S]{0,180}changeStatus/
  );
  assert.match(followup,/p_lead_status:values\.lead_status/);
  assert.match(followup,/p_lead_quality:values\.lead_quality/);
});

test('database lifecycle closes sales tasks centrally and backfills without deletion',async()=>{
  const migration=await read(migrationPath);

  assert.ok(migration.trim().length>0,'lifecycle migration must not be empty');
  assert.doesNotMatch(migration,/\bdelete\s+from\s+work_core\.tasks\b/i);
  assert.match(migration,/create\s+(?:or\s+replace\s+)?function\s+private_app\.[a-z0-9_]*sales[a-z0-9_]*task[a-z0-9_]*/i);
  assert.match(migration,/create\s+trigger\s+[a-z0-9_]+[\s\S]+on\s+sales_core\.contacts/i);
  assert.match(migration,/execute\s+function\s+private_app\./i);

  for(const status of [
    'payment_submitted',
    'paid',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ]){
    assert.match(migration,new RegExp(`'${status}'`));
  }
  for(const source of [
    'lead_assignment',
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  ]){
    assert.match(migration,new RegExp(`'${source}'`));
  }

  assert.match(migration,/update\s+work_core\.tasks[\s\S]+status\s*=\s*'completed'/i);
  assert.match(
    migration,
    /backfill|historical|existing\s+open\s+sales\s+tasks|المهام\s+القديمة/i
  );
  assert.match(
    migration,
    /completed_at\s*=[\s\S]{0,500}(?:lead_status_changed_at|last_activity_at|occurred_at)|(?:lead_status_changed_at|last_activity_at|occurred_at)[\s\S]{0,500}completed_at\s*=/i
  );

  const salesSources=[
    'lead_assignment',
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  ];
  const sourceAllowlists=[...migration.matchAll(
    /coalesce\(task\.metadata\s*->>\s*'source',\s*''\)\s+in\s*\(([\s\S]*?)\)/gi
  )].map(match=>match[1]);
  assert.ok(
    sourceAllowlists.length>=3,
    'activity resolution, historical plan, and terminal trigger need sales allowlists'
  );
  for(const allowlist of sourceAllowlists){
    for(const source of salesSources){
      assert.ok(
        allowlist.includes(`'${source}'`),
        `sales allowlist must retain ${source}`
      );
    }
    assert.doesNotMatch(allowlist,/'registration_handoff'/);
  }

  const backfillPlan=migration.match(
    /insert into sales_task_lifecycle_plan_v1[\s\S]*?;\n/
  )?.[0]||'';
  assert.match(backfillPlan,/task\.status in \('todo', 'in_progress'\)/);
  assert.match(backfillPlan,/coalesce\(task\.metadata ->> 'source', ''\) in \(/);
  assert.match(
    migration,
    /update work_core\.tasks task[\s\S]{0,2500}from sales_task_lifecycle_plan_v1 plan/
  );

  const terminalTrigger=migration.match(
    /create or replace function private_app\.complete_terminal_contact_sales_tasks_v1\(\)[\s\S]*?\n\$\$;/
  )?.[0]||'';
  assert.match(terminalTrigger,/update work_core\.tasks task/);
  assert.match(terminalTrigger,/coalesce\(task\.metadata ->> 'source', ''\) in \(/);
  assert.doesNotMatch(terminalTrigger,/'registration_handoff'/);
});
