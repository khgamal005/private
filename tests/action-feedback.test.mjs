import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('global action feedback is mounted for every application route',async()=>{
  const layout=await read('../app/layout.js');
  assert.match(layout,/SystemActionFeedback/);
  assert.match(layout,/action-feedback\.css/);
});

test('blocked controls explain missing fields, permissions, busy states, and checklist requirements',async()=>{
  const provider=await read('../components/system-action-feedback.js');
  assert.match(provider,/data-block-reason/);
  assert.match(provider,/aria-busy/);
  assert.match(provider,/requiredPermission/);
  assert.match(provider,/inferMissingFields/);
  assert.match(provider,/inferChecklist/);
  assert.match(provider,/لماذا الإجراء متوقف/);
  assert.match(provider,/الخطوة التالية/);
});

test('API failures are surfaced globally with a user-facing reason',async()=>{
  const provider=await read('../components/system-action-feedback.js');
  assert.match(provider,/requestUrl\.includes\('\/api\/'\)/);
  assert.match(provider,/payload\?\.error/);
  assert.match(provider,/تعذر الاتصال بالنظام/);
});
