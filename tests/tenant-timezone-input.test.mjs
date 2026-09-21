import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {
  businessDateKey,
  businessDateTimeInput,
  businessDateTimeToInstant,
  isTaskOverdue
} from '../lib/task-timing.mjs';

test('tenant wall time converts identically across employee browser timezones',()=>{
  const moduleUrl=new URL('../lib/task-timing.mjs',import.meta.url).href;
  const script=`import {businessDateTimeInput,businessDateTimeToInstant,businessDateKey} from ${JSON.stringify(moduleUrl)};
    const instant=businessDateTimeToInstant('2026-09-21T00:30','Asia/Riyadh');
    console.log(JSON.stringify([instant,businessDateTimeInput(instant,'Asia/Riyadh'),businessDateKey(instant,'Asia/Riyadh')]));`;
  for(const timeZone of ['UTC','America/Los_Angeles','Asia/Tokyo','Pacific/Kiritimati']){
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
      env:{...process.env,TZ:timeZone},encoding:'utf8'
    });
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),[
      '2026-09-20T21:30:00.000Z','2026-09-21T00:30','2026-09-21'
    ],timeZone);
  }
});

test('conversion handles quarter-hour offsets and crosses year boundaries',()=>{
  assert.equal(businessDateTimeToInstant('2027-01-01T00:15','Asia/Kathmandu'),
    '2026-12-31T18:30:00.000Z');
  assert.equal(businessDateTimeInput('2026-12-31T18:30:00.000Z','Asia/Kathmandu'),
    '2027-01-01T00:15');
  assert.equal(businessDateTimeToInstant('2026-12-31T23:30','America/Los_Angeles'),
    '2027-01-01T07:30:00.000Z');
});

test('nonexistent and repeated DST wall times fail before a scheduling request',()=>{
  assert.throws(()=>businessDateTimeToInstant('2026-03-08T02:30','America/New_York'),/غير موجود/);
  assert.throws(()=>businessDateTimeToInstant('2026-11-01T01:30','America/New_York'),/يتكرر/);
  assert.equal(businessDateTimeToInstant('2026-03-08T03:30','America/New_York'),
    '2026-03-08T07:30:00.000Z');
  assert.equal(businessDateTimeToInstant('2026-11-01T02:30','America/New_York'),
    '2026-11-01T07:30:00.000Z');
  assert.throws(()=>businessDateTimeToInstant('2026-10-04T02:15','Australia/Lord_Howe'),/غير موجود/);
  assert.throws(()=>businessDateTimeToInstant('2026-04-05T01:45','Australia/Lord_Howe'),/يتكرر/);
});

test('editing another field preserves the existing repeated-hour occurrence and seconds',()=>{
  for(const originalInstant of ['2026-11-01T05:30:42.456Z','2026-11-01T06:30:42.456Z']){
    assert.equal(businessDateTimeToInstant('2026-11-01T01:30','America/New_York',{originalInstant}),originalInstant);
  }
  assert.equal(businessDateTimeToInstant('2026-09-21T09:30','Asia/Riyadh',{
    originalInstant:'2026-09-21T06:30:42.456Z'
  }),'2026-09-21T06:30:42.456Z');
  assert.equal(businessDateTimeToInstant('2026-09-21T10:30','Asia/Riyadh',{
    originalInstant:'2026-09-21T06:30:42.456Z'
  }),'2026-09-21T07:30:00.000Z');
});

test('invalid dates and zones are rejected instead of silently using browser time',()=>{
  for(const value of ['',null,'2026-02-29T09:00','2026-09-31T09:00','2026-09-21T24:00','2026-13-01T09:00']){
    assert.throws(()=>businessDateTimeToInstant(value,'Asia/Riyadh'),/صالح/);
  }
  assert.throws(()=>businessDateTimeToInstant('2026-09-21T09:00','Invalid/Zone'),/المنطقة الزمنية/);
  assert.equal(businessDateTimeInput(null,'Asia/Riyadh'),'');
  assert.equal(businessDateKey(null,'Asia/Riyadh'),null);
});

test('saved due date and lateness use the same tenant midnight',()=>{
  const dueAt=businessDateTimeToInstant('2026-09-21T00:30','Asia/Riyadh');
  const task={dueAt,contactId:'customer-1'};
  assert.equal(isTaskOverdue(task,{timeZone:'Asia/Riyadh',now:'2026-09-21T20:59:59Z'}),false);
  assert.equal(isTaskOverdue(task,{timeZone:'Asia/Riyadh',now:'2026-09-21T21:00:00Z'}),true);
});
