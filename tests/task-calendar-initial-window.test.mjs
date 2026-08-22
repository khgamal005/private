import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  buildTaskCalendarInitialWindow
} from '../lib/task-calendar-initial-window.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('sales initial window keeps exact totals and only today data',()=>{
  const now=new Date('2026-08-22T21:30:00.000Z');
  const distributionTask={
    id:'distribution',
    status:'todo',
    dueAt:'2026-08-24T09:00:00.000Z',
    contactId:'contact-distribution'
  };
  const snapshot={
    timezone:'Africa/Cairo',
    viewer:{viewTeam:true},
    tasks:[
      {
        id:'today-open',
        status:'todo',
        dueAt:'2026-08-22T22:00:00.000Z',
        contactId:'contact-today'
      },
      {
        id:'today-completed',
        status:'completed',
        dueAt:'2026-08-22T22:10:00.000Z',
        contactId:'contact-completed'
      },
      {
        id:'overdue-open',
        status:'in_progress',
        dueAt:'2026-08-22T20:59:00.000Z',
        contactId:'contact-overdue'
      },
      {
        id:'future-open',
        status:'todo',
        dueAt:'2026-08-24T09:00:00.000Z',
        contactId:'contact-future',
        demo:true
      },
      {
        id:'completed-late',
        status:'completed',
        completionTiming:'late',
        dueAt:'2026-08-20T09:00:00.000Z'
      }
    ],
    contacts:[
      {id:'contact-today',name:'Today'},
      {id:'contact-completed',name:'Completed'},
      {id:'contact-overdue',name:'Overdue'},
      {id:'contact-future',name:'Future'},
      {id:'contact-distribution',name:'Distribution'}
    ],
    dailyLeadDistribution:{
      total:1,
      taskIds:['distribution'],
      byStaff:[{staffId:'staff-1',count:1,taskIds:['distribution']}],
      items:[distributionTask]
    }
  };
  const original=structuredClone(snapshot);

  const result=buildTaskCalendarInitialWindow(snapshot,{now});

  assert.deepEqual(result.tasks.map(task=>task.id),['today-open']);
  assert.deepEqual(
    result.contacts.map(contact=>contact.id).sort(),
    ['contact-distribution','contact-today']
  );
  assert.deepEqual(result.dailyLeadDistribution.items,[distributionTask]);
  assert.deepEqual(result.calendarSummary,{
    open:3,
    overdue:1,
    today:1,
    completedLate:1
  });
  assert.equal(result.completeTaskCount,5);
  assert.equal(result.hasDemoTasks,true);
  assert.equal(result.partial,true);
  assert.deepEqual(snapshot,original);
  assert.notEqual(result.tasks,snapshot.tasks);
  assert.notEqual(result.contacts,snapshot.contacts);
  assert.notEqual(
    result.dailyLeadDistribution.items,
    snapshot.dailyLeadDistribution.items
  );
});

test('page compacts sales only and the full route derives scope server-side',async()=>{
  const [page,calendar,route,loading,serverAuth]=await Promise.all([
    read('app/tenant/[slug]/tasks/page.js'),
    read('components/task-calendar-page.js'),
    read('app/api/tenant/task-calendar/route.js'),
    read('app/tenant/[slug]/tasks/loading.js'),
    read('lib/server-auth.js')
  ]);

  assert.match(page,/buildTaskCalendarInitialWindow\(calendar\)/);
  assert.match(page,/salesTaskScope[\s\S]{0,120}\?buildTaskCalendarInitialWindow/);
  assert.match(page,/:calendar/);
  assert.match(route,/requireTenantPermission\(slug,'tenant\.work\.read'\)/);
  assert.match(route,/resolveTenantRoleKey/);
  assert.match(route,/SALES_TASK_ROLES\.has\(roleKey\)\?'sales':'all'/);
  assert.doesNotMatch(route,/body\?\.(?:taskScope|includeSales)/);
  assert.match(route,/private, no-store, max-age=0/);
  assert.match(calendar,/ensureCompleteCalendar/);
  assert.match(calendar,/\/api\/tenant\/task-calendar/);
  assert.match(calendar,/data\.partial&&data\.calendarSummary/);
  assert.match(calendar,/const tasksByDay=new Map\(\)/);
  assert.match(calendar,/completeAbortRef\.current\?\.abort\(\)/);
  assert.match(calendar,/ensureCompleteCalendar\(\{force:true\}\)/);
  assert.match(calendar,/if\(!force\)return completeRequestRef\.current/);
  assert.match(calendar,/currentSlugRef\.current=slug/);
  assert.match(calendar,/requestSlug!==currentSlugRef\.current/);
  assert.match(
    calendar,
    /if\(dataRef\.current\?\.partial\)\{[\s\S]{0,220}completeAbortRef\.current\?\.abort\(\)[\s\S]{0,220}router\.refresh\(\)/
  );
  assert.match(calendar,/if\(initialData\?\.partial\)/);
  assert.match(calendar,/setMode\('agenda'\)/);
  assert.equal(
    (calendar.match(/router\.refresh\(\)/g)||[]).length,
    1,
    'only the guarded partial-window refresh may use router.refresh'
  );
  assert.match(loading,/aria-busy="true"/);
  assert.match(serverAuth,/\[auth-rpc-recovered\]/);
  assert.match(serverAuth,/totalDurationMs/);
  assert.match(serverAuth,/retryReason/);
  assert.doesNotMatch(
    serverAuth,
    /retryReason[\s\S]{0,120}(?:error\.message|detail)/
  );
});
