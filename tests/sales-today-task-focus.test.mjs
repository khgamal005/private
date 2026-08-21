import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('sales roles open directly on the team daily task list',async()=>{
  const [page,calendar]=await Promise.all([
    read('app/tenant/[slug]/tasks/page.js'),
    read('components/task-calendar-page.js')
  ]);

  assert.match(page,/resolveTenantRoleKey/);
  assert.match(page,/const SALES_TASK_ROLES=new Set/);
  assert.match(page,/'sales_manager'/);
  assert.match(page,/'sales_supervisor'/);
  assert.match(page,/'sales_user'/);
  assert.match(
    page,
    /initialFocus=\{SALES_TASK_ROLES\.has\(roleKey\)\?'today':'calendar'\}/
  );
  assert.match(
    calendar,
    /useState\(\(\)=>startsInTodayFocus\?'today':'all'\)/
  );
  assert.match(
    calendar,
    /useState\(\(\)=>startsInTodayFocus\?'agenda':'month'\)/
  );
  assert.match(calendar,/function focusToday\(\)/);
  assert.match(calendar,/setFilter\('today'\)/);
  assert.match(calendar,/setMode\('agenda'\)/);
  assert.match(calendar,/>مهام اليوم \(\{number\(summary\.today\)\}\)<\/button>/);
});

test('today keeps earlier open tasks visible after their due time',async()=>{
  const calendar=await read('components/task-calendar-page.js');

  assert.match(calendar,/const OPEN_TASK_STATUSES=new Set/);
  assert.match(calendar,/function isTodayTask\(task,today=new Date\(\)\)/);
  assert.match(
    calendar,
    /OPEN_TASK_STATUSES\.has\(task\.status\)&&sameDay\(task\.dueAt,today\)/
  );
  assert.match(calendar,/today:tasks\.filter\(task=>isTodayTask\(task\)\)\.length/);
  assert.match(calendar,/if\(filter==='today'\)return isTodayTask\(task\)/);
  assert.match(calendar,/تشمل المتأخر منها اليوم/);
});
