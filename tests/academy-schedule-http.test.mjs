import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as requestPolicy from '../lib/training-request.mjs';
import * as academyPolicy from '../lib/academy-policy.mjs';
import * as schedulePolicy from '../lib/academy-schedule.mjs';
const commandId='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269';
const base={runId:commandId,expectedRunVersion:'a'.repeat(32),title:'Lesson',startsAt:'2026-09-22T12:00:00Z',endsAt:'2026-09-22T13:00:00Z',deliveryMode:'online',meetingUrl:'https://meet.example.test/lesson'};
function harness(handler=async()=>({saved:true})){
 const calls=[],exports={};
 const source=ts.transpileModule(readFileSync(new URL('../app/api/academy-schedule/[action]/route.js',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInThisContext(`(function(require,exports){${source}\n})`)(name=>{
  if(name.endsWith('training-request.mjs'))return requestPolicy;
  if(name.endsWith('academy-policy.mjs'))return academyPolicy;
  if(name.endsWith('academy-schedule.mjs'))return schedulePolicy;
  if(name.endsWith('training-server'))return {trainingJson:(body,status=200)=>({body,status}),trainingRpc:async(...args)=>{calls.push(args);return handler(...args);}};
  throw Error(name);
 },exports);
 return {...exports,calls};
}
function request(action,body,origin='https://odeir.com'){
 return new Request(`https://odeir.com/api/academy-schedule/${action}`,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});
}
const invoke=(h,action,body,origin)=>h.POST(request(action,body,origin),{params:Promise.resolve({action})});

test('scheduling HTTP rejects cross-origin, unsupported action, oversized requests and unsafe links before any RPC',async()=>{
 const h=harness(),body={tenantSlug:'marktone',commandId,payload:base};
 assert.equal((await invoke(h,'save_session',body,'https://evil.example')).status,403);
 assert.equal((await invoke(h,'delete_all_sessions',body)).status,404);
 assert.equal((await invoke(h,'save_session',{...body,payload:{...base,title:'a'.repeat(15000)}})).status,413);
 for(const meetingUrl of ['javascript:alert(1)','https://user:password@example.test/room','https://example.test\\@evil.test'])assert.equal((await invoke(h,'save_session',{...body,payload:{...base,meetingUrl}})).status,400);
 assert.equal(h.calls.length,0);
});

test('scheduling forwards only the finite command payload and exact tenant; database permission failures remain failures',async()=>{
 const h=harness();const response=await invoke(h,'save_session',{tenantSlug:'marktone',commandId,actorSubjectId:'forged',payload:{...base,tenantId:'foreign',role:'manager',subjectId:'forged',metadata:{status:'completed'}}});
 assert.equal(response.status,200);assert.equal(h.calls[0][0],'v1_academy_schedule_action');assert.equal(h.calls[0][1].p_slug,'marktone');
 assert.deepEqual(h.calls[0][1].p_payload,{...base,instructorName:'',location:''});
 const denied=harness(async()=>{throw requestPolicy.trainingProblem('forbidden',403);});
 assert.equal((await invoke(denied,'complete_run',{tenantSlug:'marktone',commandId,payload:{runId:commandId,expectedRunVersion:base.expectedRunVersion,reviewed:true}})).status,403);
});

test('bounded schedule snapshot validates pagination and target ID without invoking mutation',async()=>{
 const h=harness();assert.equal((await invoke(h,'snapshot',{tenantSlug:'marktone',payload:{offset:0,runId:commandId}})).status,200);
 assert.deepEqual(h.calls[0],['v1_academy_schedule_snapshot',{p_slug:'marktone',p_run_id:commandId,p_offset:0}]);
 for(const payload of [{offset:100001},{offset:-1},{runId:'foreign'}])assert.equal((await invoke(h,'snapshot',{tenantSlug:'marktone',payload})).status,400);
 assert.equal(h.calls.length,1);
});
