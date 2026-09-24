import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import * as requests from '../lib/training-request.mjs';
import * as contract from '../lib/zoom-contract.mjs';
import {reportCsv} from '../supabase/functions/_shared/zoom-evidence.mjs';
import {call,id,T,ADMIN_AUTH,LEARNER_AUTH,login} from './fixtures/zoom-database.mjs';
import {seedZoomDerivative,revokeSource} from './fixtures/zoom-derivative.mjs';

const require=createRequire(import.meta.url);
function load(path,dependency){
 const output=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
 const componentModule={exports:{}};vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(dependency,componentModule,componentModule.exports);return componentModule.exports;
}

test('T62: review UI -> real Next handler -> authorized SQL deletion, with explicit confirmation and no provider call',async t=>{
 const {db,draftId,connection}=await seedZoomDerivative();t.after(()=>db.close());await revokeSource(db,connection);
 let providers=0,sequence=98000;const calls=[];
 const route=load('../app/api/zoom/[action]/route.js',name=>{
  if(name==='node:crypto')return require(name);
  if(name==='next/headers')return {cookies:async()=>{throw Error('No cookie mutation expected');}};
  if(name.endsWith('training-request.mjs'))return requests;
  if(name.endsWith('zoom-contract.mjs'))return contract;
  if(name.endsWith('zoom-evidence.mjs'))return {reportCsv};
  if(name.endsWith('zoom-snapshot'))return {zoomSnapshot:async()=>{throw Error('Unexpected workspace snapshot');}};
  if(name.endsWith('zoom-server'))return {zoomGateway:async()=>{providers++;throw Error('Unexpected provider call');}};
  if(name.endsWith('training-server'))return {trainingJson:(body,status=200)=>({body,status}),trainingRpc:async(name,args)=>{calls.push({name,args});try{return await call(db,`public.${name}`,args);}catch(error){throw requests.trainingProblem(error.message,/forbidden|permission/.test(error.message)?403:409);}}};
  throw Error(name);
 });
 const post=(action,payload={},origin='https://odeir.com')=>route.POST(new Request(`https://odeir.com/api/zoom/${action}`,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify({tenantSlug:'marktone',commandId:id(sequence++),payload})}),{params:Promise.resolve({action})});
 assert.equal((await post('derivative_delete',{draftId,reviewed:true},'https://attacker.example.test')).status,403);assert.equal(calls.length,0);
 await login(db,LEARNER_AUTH);assert.equal((await post('derivative_preview',{draftId,role:'admin',tenantId:T})).status,403);await login(db,ADMIN_AUTH);
 const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://odeir.com'}),previous=new Map();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 let root;
 try{
  const {ZoomRetention}=load('../components/zoom-retention.jsx',name=>name.endsWith('.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>key})}:require(name));
  const {createRoot}=await import('react-dom/client');root=createRoot(document.getElementById('app'));let pending=Promise.resolve();
  const action=(name,payload)=>{pending=post(name,payload).then(result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;});return pending;};
  const click=async text=>act(async()=>{const button=[...document.querySelectorAll('button')].find(x=>x.textContent===text);assert.ok(button,text);button.click();await pending;});
  await act(async()=>root.render(React.createElement(ZoomRetention,{action,busy:false})));
  await click('عرض طلبات حذف المشتقات');await click('مراجعة النسخ');
  assert.ok(document.body.textContent.includes('نسخة التأليف المنشورة: 1'));
  const form=document.querySelector('form');assert.equal(form.checkValidity(),false,'human review and reason are required');
  form.elements.reason.value='Human approved synthetic UI deletion';form.elements.reviewed.checked=true;assert.equal(form.checkValidity(),true);
  await act(async()=>{form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await pending;await pending;});
  assert.equal(providers,0);assert.ok((await db.query('select deleted_at from zoom_core.authoring_sources')).rows[0].deleted_at);
  const deletion=calls.find(x=>x.name==='v1_zoom_derivative_delete');assert.equal(deletion.args.p_payload.reviewed,true);assert.match(deletion.args.p_payload.previewHash,/^[a-f0-9]{64}$/);
 }finally{
  if(root)await act(async()=>root.unmount());dom.window.close();for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}
 }
});
