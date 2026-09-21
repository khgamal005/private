import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';

test('sale collections load requested cash filters, recover errors and keep currencies and unknown source visible',async()=>{
 const require=createRequire(import.meta.url);
 const source=await readFile(new URL('../components/campaign-opportunity-collections.js',import.meta.url),'utf8');
 let code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>`from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`);
 const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com/tenant/fixture/reports/campaigns'});
 const previous={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch,act:globalThis.IS_REACT_ACT_ENVIRONMENT};
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client');
 const totals=[{currency:'SAR',grossMinor:12000,refundMinor:2000,netMinor:10000},{currency:'EGP',grossMinor:5000,refundMinor:0,netMinor:5000}];
 const data={opportunities:1,unlinkedEvents:1,range:{timezone:'Asia/Riyadh'},totals,groups:[{key:'unknown',documented:false,opportunities:1,money:totals}]};
 let calls=0;const requests=[];
 globalThis.fetch=async url=>{requests.push(new URL(url,'https://odeir.com'));return ++calls===1?{ok:false,json:async()=>({error:'forbidden'})}:{ok:true,json:async()=>data};};
 const root=createRoot(document.getElementById('root'));
 try{
  await act(()=>root.render(React.createElement(Component,{slug:'fixture',filters:{dateFrom:'2026-09-01',dateTo:'2026-09-02',staff:'staff-id',course:'course-id',search:'source'}})));
  assert.equal(calls,0);
  await act(()=>document.querySelector('button').click());
  assert.match(document.querySelector('[role="alert"]').textContent,/تحتاج صلاحية/);
  assert.equal(document.querySelector('button').disabled,false);
  await act(()=>document.querySelector('button').click());
  assert.equal(requests[1].searchParams.get('action'),'opportunity-collections');
  assert.equal(requests[1].searchParams.get('staff'),'staff-id');assert.equal(requests[1].searchParams.get('course'),'course-id');assert.equal(requests[1].searchParams.get('q'),'source');
  assert.equal(document.querySelectorAll('tbody tr').length,2);assert.equal(document.querySelector('[role="alert"]'),null);
  assert.match(document.body.textContent,/مصدر فرصة البيع غير موثق/);assert.match(document.body.textContent,/لم تربط بفرصة بيع/);
  assert.match(document.body.textContent,/لا يُحسب العائد على الإنفاق/);assert.match(document.body.textContent,/Asia\/Riyadh/);
 }finally{
  await act(()=>root.unmount());dom.window.close();
  globalThis.window=previous.window;globalThis.document=previous.document;globalThis.fetch=previous.fetch;globalThis.IS_REACT_ACT_ENVIRONMENT=previous.act;
 }
});
