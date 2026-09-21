import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import * as timing from '../lib/task-timing.mjs';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/operating-foundation-panel.js',import.meta.url),'utf8');
const code=ts.transpileModule(source,{fileName:'operating.jsx',compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true
}}).outputText;
const mod={exports:{}};
new Function('require','module','exports',code)(name=>{
  if(name==='next/link')return {__esModule:true,default:props=>React.createElement('a',props)};
  if(name==='../lib/task-timing.mjs')return timing;
  if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
  return require(name);
},mod,mod.exports);
const Panel=mod.exports.default;
const shift={isoDay:1,startsAt:'09:00:00',endsAt:'17:00:00'};
const fixture=()=>({
  ready:false,checks:{basicData:true,firstBranch:true,currency:false,timezone:true,taxConfiguration:false,teamAndPermissions:true,intakeSource:true},
  tenant:{name:'منشأة تجريبية',legalName:'مركز تجريبي للتدريب',timezone:'Asia/Riyadh'},
  finance:{configured:false},setup:{version:3,intakeSource:'manual',staffSchedulingEnabled:false},
  canManagePeople:true,branches:[{id:'branch-1',name:'الرئيسي',is_default:true,active:true}],
  departments:[{id:'sales',name:'المبيعات'},{id:'admissions',name:'القبول'}],
  staff:[
    {id:'ali',name:'علي',status:'active',departmentId:'sales',branchId:'branch-1',extraDepartments:[],shifts:[shift],absences:[]},
    {id:'sara',name:'سارة',status:'active',departmentId:'sales',branchId:'branch-1',extraDepartments:[],shifts:[shift],absences:[]},
    {id:'omar',name:'عمر',status:'active',departmentId:'admissions',branchId:'branch-1',extraDepartments:[],shifts:[shift],absences:[]}
  ]
});

async function withPanel(data,handler,run){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.test',pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','FormData','IS_REACT_ACT_ENVIRONMENT','fetch'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
    FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true});
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    const result=handler?await handler(body):{data};
    return {ok:!result.error,json:async()=>result};
  };
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  const click=async text=>act(async()=>{
    const button=[...document.querySelectorAll('button')].find(item=>item.textContent===text);
    assert.ok(button,`Missing button ${text}`);button.click();
  });
  const submit=async form=>act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  try{
    await act(async()=>root.render(React.createElement(Panel,{slug:'synthetic',initialData:data})));
    await run({dom,requests,click,submit});
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
  }
}

test('readiness is authoritative and opening the panel never writes or activates scheduling',async()=>{
  const data=fixture();
  await withPanel(data,null,async({requests,submit})=>{
    assert.equal(requests.length,0);
    const checks=[...document.querySelectorAll('.checks input')];
    assert.equal(checks.length,7);assert.ok(checks.every(item=>item.disabled));
    assert.equal(checks.filter(item=>item.checked).length,5);
    assert.equal(document.querySelector('a[href$="/accounting/settings"]').textContent,'فتح إعدادات الحسابات ←');
    const form=document.querySelector('form');
    await submit(form);
    assert.equal(requests.length,1);
    assert.equal(requests[0].body.p_action,'save_setup');
    assert.equal(requests[0].body.p_payload.intakeSource,'manual');
    assert.equal(requests[0].body.p_payload.expectedVersion,3);
    assert.equal(requests[0].body.p_payload.confirmTimezoneChange,false);
  });
});

test('scheduling requires preview then explicit confirmation and uses the preview version',async()=>{
  const data=fixture();
  await withPanel(data,body=>body.p_action==='preview_scheduling'
    ?{data:{version:8,activeStaff:3,withoutShift:0,legacyRowsWillChange:0}}
    :{data:{...data,setup:{...data.setup,version:9,staffSchedulingEnabled:true}}},async({requests,click,dom})=>{
    await click('مراجعة تفعيل تطبيق المواعيد');
    assert.deepEqual(requests.map(item=>item.body.p_action),['preview_scheduling']);
    const review=document.querySelector('[aria-label="مراجعة تطبيق مواعيد العمل"]');
    const confirm=[...review.querySelectorAll('button')].find(item=>item.textContent==='تأكيد التفعيل');
    assert.equal(confirm.disabled,true);
    await act(async()=>review.querySelector('input[type=checkbox]').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
    assert.equal(confirm.disabled,false);
    await click('تأكيد التفعيل');
    assert.deepEqual(requests[1].body.p_payload,{enabled:true,confirmed:true,expectedVersion:8});
    assert.ok([...document.querySelectorAll('button')].some(item=>item.textContent==='مراجعة إيقاف تطبيق المواعيد'));
  });
});

test('missing shifts block activation and a stale preview never changes the displayed state',async()=>{
  const data=fixture();let withoutShift=1;
  await withPanel(data,body=>body.p_action==='preview_scheduling'
    ?{data:{version:3,activeStaff:3,withoutShift,legacyRowsWillChange:0}}
    :{error:'operating_preview_confirmation_required'},async({requests,click,dom})=>{
    await click('مراجعة تفعيل تطبيق المواعيد');
    await act(async()=>document.querySelector('[aria-label="مراجعة تطبيق مواعيد العمل"] input').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
    const confirm=()=>[...document.querySelectorAll('button')].find(item=>item.textContent==='تأكيد التفعيل');
    assert.equal(confirm().disabled,true);
    await click('تأكيد التفعيل');assert.equal(requests.length,1);
    await click('تراجع');withoutShift=0;
    await click('مراجعة تفعيل تطبيق المواعيد');
    await act(async()=>document.querySelector('[aria-label="مراجعة تطبيق مواعيد العمل"] input').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
    await click('تأكيد التفعيل');
    assert.match(document.querySelector('[role=alert]').textContent,/معاينة جديدة/);
    assert.ok([...document.querySelectorAll('button')].some(item=>item.textContent==='مراجعة تفعيل تطبيق المواعيد'));
    assert.equal(requests.filter(item=>item.body.p_action==='set_scheduling').length,1);
  });
});

test('absence restricts cover choices and sends tenant-zone dates, not browser wall time',async()=>{
  const data=fixture();
  await withPanel(data,null,async({requests,click,submit})=>{
    await click('إجازة');
    const form=document.querySelector('.staffEditor');
    assert.deepEqual([...form.querySelector('[name=coverStaffId]').options].map(item=>item.value),['','sara']);
    form.querySelector('[name=startsAt]').value='2026-10-01T09:00';
    form.querySelector('[name=endsAt]').value='2026-10-01T08:00';
    form.querySelector('[name=reason]').value='إجازة تجريبية';
    await submit(form);assert.equal(requests.length,0);
    assert.match(form.querySelector('[role=alert]').textContent,/نهاية الإجازة/);
    form.querySelector('[name=endsAt]').value='2026-10-02T17:00';
    form.querySelector('[name=coverStaffId]').value='sara';
    await submit(form);
    assert.equal(requests[0].body.p_action,'record_absence');
    assert.deepEqual(requests[0].body.p_payload,{staffId:'ali',startsAt:'2026-10-01T06:00:00.000Z',
      endsAt:'2026-10-02T14:00:00.000Z',coverStaffId:'sara',reason:'إجازة تجريبية'});
  });
});

test('staff editor preserves primary department and branch while adding a second department',async()=>{
  const data=fixture();
  await withPanel(data,null,async({requests,click,submit,dom})=>{
    await click('تنظيم العمل');
    const form=document.querySelector('.staffEditor');
    await act(async()=>form.querySelector('.extraDepartments input').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
    await submit(form);
    assert.deepEqual(requests[0].body.p_payload,{staffId:'ali',primaryDepartmentId:'sales',branchId:'branch-1',
      extraDepartmentIds:['admissions'],shifts:[{isoDay:1,startsAt:'09:00',endsAt:'17:00'}]});
  });
});

test('settings permission without people management hides employee mutation controls',async()=>{
  const data={...fixture(),canManagePeople:false,staff:[]};
  await withPanel(data,null,async({requests})=>{
    assert.equal(requests.length,0);
    assert.equal(document.querySelector('[id=staff-scheduling-title]'),null);
    assert.ok(![...document.querySelectorAll('button')].some(item=>item.textContent==='تنظيم العمل'));
  });
});
