import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import * as timing from '../lib/task-timing.mjs';
import {serializeFollowupDetails} from '../lib/sales-followup-details.mjs';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/task-calendar-page.js',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{
  fileName:'calendar.jsx',compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true
  }
}).outputText;
const mod={exports:{}};
new Function('require','module','exports',compiled)(name=>{
  if(name==='next/navigation')return {useRouter:()=>({refresh(){}})};
  if(name==='../lib/task-timing.mjs')return timing;
  if(name==='../lib/customer-phone.mjs')return {formatCustomerPhone:v=>v,toCustomerDialNumber:v=>v};
  if(name==='./sales-followup-modal')return {__esModule:true,default:()=>null,SalesQualityBadge:()=>null};
  if(name==='./woocommerce-admission-modal')return {__esModule:true,default:()=>null};
  if(name.endsWith('.module.css'))return {};
  return require(name);
},mod,mod.exports);
const Calendar=mod.exports.default;

test('calendar cells, day lookup and scheduling stay on the tenant clock in a foreign browser',async()=>{
  const previousZone=process.env.TZ;
  process.env.TZ='Asia/Tokyo';
  const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.test',pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','FormData','IS_REACT_ACT_ENVIRONMENT','fetch','Date'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  const RealDate=Date;
  class FixedDate extends RealDate{
    constructor(...args){super(...(args.length?args:['2026-09-21T12:00:00Z']));}
    static now(){return RealDate.parse('2026-09-21T12:00:00Z');}
  }
  Object.assign(globalThis,{
    window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
    FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true,Date:FixedDate
  });
  const tasks=Array.from({length:5},(_,index)=>({
    id:`task-${index}`,title:`مهمة ${index}`,status:'todo',taskSource:'general',
    dueAt:'2026-09-22T08:00:00Z',assignedStaffId:'staff-1'
  }));
  const data={timezone:'Pacific/Honolulu',tasks,contacts:[],staff:[],courses:[],courseRuns:[],
    viewer:{canWriteWork:true,canWriteCrm:false,viewTeam:true}};
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    const response=url.endsWith('/calendar-day')
      ?{timezone:'Pacific/Honolulu',tasks}
      :url==='/api/tenant/task-calendar'?data:{};
    return {ok:true,json:async()=>({data:response})};
  };
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  try{
    await act(async()=>root.render(React.createElement(Calendar,{slug:'synthetic-tenant',initialData:data})));
    const cell=[...document.querySelectorAll('.role-calendar-grid article')]
      .find(item=>item.textContent.includes('مهمة 0'));
    assert.equal(cell.querySelector('header b').textContent,'21');
    assert.match(document.querySelector('.calendar-controlbar').textContent,/Pacific\/Honolulu/);
    const expectedTime=new Intl.DateTimeFormat('ar-SA',{
      timeZone:'Pacific/Honolulu',hour:'2-digit',minute:'2-digit'
    }).format(new RealDate('2026-09-22T08:00:00Z'));
    assert.ok(cell.textContent.includes(expectedTime));
    await act(async()=>cell.querySelector('.more-tasks').click());
    assert.equal(requests.find(item=>item.url.endsWith('/calendar-day')).body.p_day,'2026-09-21');
    await act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'})));
    await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='+ مهمة جديدة').click());
    const form=document.querySelector('.calendar-task-form');
    form.querySelector('[name="title"]').value='موعد بتوقيت المنشأة';
    form.querySelector('[name="due_at"]').value='2026-09-23T09:00';
    assert.match(form.querySelector('[name="due_at"]').closest('label').textContent,/Pacific\/Honolulu/);
    await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(requests.find(item=>item.url.endsWith('/create-task')).body.p_due_at,'2026-09-23T19:00:00.000Z');
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
    if(previousZone===undefined)delete process.env.TZ;else process.env.TZ=previousZone;
  }
});

test('sales followup displays tenant timezone and blocks a DST gap before sending',async()=>{
  const details={revision:'fixture-1',rows:[],phones:[],primaryPhone:'+966500000001'};
  const followupSource=readFileSync(new URL('../components/sales-followup-modal.js',import.meta.url),'utf8');
  const followupCode=ts.transpileModule(followupSource,{
    fileName:'followup.jsx',compilerOptions:{target:ts.ScriptTarget.ES2022,
      module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}
  }).outputText;
  const followupModule={exports:{}};
  new Function('require','module','exports',followupCode)(name=>{
    if(name==='next/dynamic')return {__esModule:true,default:()=>()=>null};
    if(name==='./sales-followup-details')return {__esModule:true,default:()=>null,
      useFollowupDetails:()=>({details,setDetails(){},retry(){},loadError:null})};
    if(name==='../lib/sales-followup-details.mjs')return {serializeFollowupDetails};
    if(name==='../lib/task-timing.mjs')return timing;
    return require(name);
  },followupModule,followupModule.exports);
  const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.test',pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','FormData','IS_REACT_ACT_ENVIRONMENT','fetch'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,
    HTMLElement:dom.window.HTMLElement,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true});
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    return {ok:true,json:async()=>({data:{taskUpdated:true}})};
  };
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  try{
    await act(async()=>root.render(React.createElement(followupModule.exports.default,{
      slug:'synthetic-tenant',timeZone:'America/New_York',
      contact:{id:'contact-1',name:'عميل تجريبي',leadStatus:'follow_up'},onClose(){},onSaved(){}
    })));
    const form=document.querySelector('form');
    form.querySelector('[name="summary"]').value='متابعة تجريبية';
    const input=form.querySelector('[name="next_action_at"]');
    assert.match(input.closest('label').textContent,/America\/New_York/);
    input.value='2026-03-08T02:30';
    await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(requests.length,0);
    assert.match(form.querySelector('[role="alert"]').textContent,/غير موجود/);
    input.value='2026-03-08T03:30';
    await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(requests.length,1);
    assert.equal(requests[0].body.p_next_action_at,'2026-03-08T07:30:00.000Z');
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
  }
});
