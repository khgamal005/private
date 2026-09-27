import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import * as detailsContract from '../lib/sales-followup-details.mjs';
import * as phoneContract from '../lib/customer-phone.mjs';

test('actual followup components keep course rows independent and submit one atomic request',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://fixture.local'});
  const previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
    HTMLInputElement:dom.window.HTMLInputElement,Event:dom.window.Event,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const require=createRequire(import.meta.url);
  const React=await import('react');
  const {createRoot}=await import('react-dom/client');
  const swc=require('next/dist/build/swc');await swc.loadBindings();
  let components;
  async function compile(path){
    const source=await readFile(new URL(path,import.meta.url),'utf8');
    const {code}=await swc.transform(source,{filename:path,jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}});
    const compiledModule={exports:{}};
    const localRequire=name=>{
      if(name.endsWith('.module.css'))return new Proxy({},{get:(_,key)=>key==='__esModule'?false:String(key)});
      if(name==='next/dynamic')return ()=>()=>null;
      if(name==='./sales-followup-details')return components;
      if(name.endsWith('sales-followup-details.mjs'))return detailsContract;
      if(name.endsWith('customer-phone.mjs'))return phoneContract;
      return require(name);
    };
    new Function('module','exports','require',code)(compiledModule,compiledModule.exports,localRequire);
    return compiledModule.exports;
  }
  components=await compile('../components/sales-followup-details.js');
  const Modal=(await compile('../components/sales-followup-modal.js')).default;
  const originalFetch=globalThis.fetch;const writes=[];let resolveContext,failSave=true,contextOverride={};
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('sales-followup-context'))return new Promise(resolve=>{resolveContext=()=>resolve({ok:true,json:async()=>({data:{
      revision:'r1',primaryPhone:'0501111111',timezone:'Asia/Riyadh',courseInterests:[{courseId:'c1'}],additionalPhones:[],...contextOverride
    }})});});
    if(url.endsWith('sales-followup-options'))return {ok:true,json:async()=>({data:{courseId:body.p_course_id,runs:[{
      id:body.p_course_id+'-run',title:'دفعة '+body.p_course_id,startsAt:'2026-10-01T09:00:00Z',sessions:[
        {id:body.p_course_id+'-s1',title:'محاضرة أولى',startsAt:'2026-10-01T09:00:00Z'},
        {id:body.p_course_id+'-s2',title:'محاضرة ثانية',startsAt:'2026-10-03T09:00:00Z'}
      ]
    }]}})};
    if(url.endsWith('record-sales-followup')){
      writes.push(body);
      if(failSave)throw new Error('انقطع الاتصال');
      return {ok:true,json:async()=>({data:{taskUpdated:true,id:'activity'}})};
    }
    throw new Error('Unexpected test request: '+url);
  };
  const root=createRoot(document.getElementById('root'));
  t.after(async()=>{
    await React.act(async()=>root.unmount());globalThis.fetch=originalFetch;
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    dom.window.close();
  });
  let saved=0;
  const modalProps={
    slug:'fixture',contact:{id:'contact',name:'عميل تجريبي',phone:'0501111111',leadStatus:'interested',leadQuality:'good'},
    courses:[{id:'c1',nameAr:'دورة أولى'},{id:'c2',nameAr:'دورة ثانية'},{id:'c3',nameAr:'دورة ثالثة'}],
    onClose:()=>{},onSaved:()=>{saved++;}
  };
  await React.act(async()=>root.render(React.createElement(Modal,modalProps)));
  const doc=dom.window.document;
  const button=text=>[...doc.querySelectorAll('button')].find(item=>item.textContent.includes(text));
  const fields=text=>[...doc.querySelectorAll('label')].filter(item=>Array.from(item.childNodes).filter(node=>node.nodeType===3).map(node=>node.textContent).join('').trim()===text).map(item=>item.querySelector('select,input,textarea'));
  async function click(element){assert.ok(element);await React.act(async()=>element.click());}
  async function select(element,value){assert.ok(element);await React.act(async()=>{element.value=value;element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});}
  async function fill(element,value){assert.ok(element);await React.act(async()=>{
    const proto=element.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);
    element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  });}
  assert.equal(button('حفظ النتيجة').disabled,true);
  await React.act(async()=>resolveContext());
  assert.equal(button('حفظ النتيجة').disabled,false);
  await select(fields('الدفعة')[0],'c1-run');
  await select(fields('موعد حضور الدورة')[0],'c1-s2');
  await click(button('إضافة دورة'));
  await select(fields('الدورة المهتم بها')[1],'c2');
  await select(fields('الدفعة')[1],'c2-run');
  await select(fields('موعد حضور الدورة')[1],'c2-s1');
  assert.equal(fields('موعد حضور الدورة')[0].value,'c1-s2');
  assert.equal(fields('الدورة المهتم بها')[1].querySelector('[value="c1"]').disabled,true);
  await select(fields('الدورة المهتم بها')[1],'c3');
  assert.equal(fields('الدفعة')[1].value,'');assert.equal(fields('موعد حضور الدورة')[1].value,'');
  await select(fields('الدورة المهتم بها')[1],'c2');
  await select(fields('الدفعة')[1],'c2-run');await select(fields('موعد حضور الدورة')[1],'c2-s1');
  await click(button('إضافة رقم'));await fill(fields('رقم إضافي 1')[0],'+966501111111');
  await fill(doc.querySelector('[name="summary"]'),'يرغب في دورتين');
  await fill(doc.querySelector('[name="next_action_at"]'),'2026-09-16T12:00');
  const submit=async()=>React.act(async()=>doc.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  await submit();assert.equal(writes.length,0);assert.match(doc.body.textContent,/الرقم مضاف بالفعل/);
  await fill(fields('رقم إضافي 1')[0],'0551111111');
  await submit();assert.equal(writes.length,1);assert.match(doc.body.textContent,/انقطع الاتصال/);
  await submit();assert.equal(writes.length,2);assert.equal(writes[0].p_command_id,writes[1].p_command_id);
  assert.deepEqual(writes[0].p_course_interests,[
    {courseId:'c1',courseRunId:'c1-run',attendanceSessionId:'c1-s2'},
    {courseId:'c2',courseRunId:'c2-run',attendanceSessionId:'c2-s1'}
  ]);
  await click(doc.querySelector('[aria-label="إزالة الدورة 1"]'));
  assert.equal(fields('الدورة المهتم بها')[0].value,'c2');assert.equal(fields('موعد حضور الدورة')[0].value,'c2-s1');
  await select(doc.querySelector('[name="lead_status"]'),'payment_submitted');
  assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c2');
  failSave=false;await submit();assert.equal(saved,1);
  assert.equal(writes.at(-1).p_payment_course_id,'c2');assert.equal(writes.at(-1).p_next_action_at,null);

  async function mountPaymentCase(key,context){
    contextOverride=context;
    await React.act(async()=>root.render(React.createElement(Modal,{...modalProps,key})));
    await React.act(async()=>resolveContext());
    await select(doc.querySelector('[name="lead_status"]'),'payment_submitted');
    await fill(doc.querySelector('[name="summary"]'),'بلاغ دفع تجريبي');
  }
  await t.test('legacy course-less opportunity offers a newly selected course and submits through native validation',async()=>{
    await mountPaymentCase('legacy',{courseInterests:[],openOpportunities:[{id:'old-sale',courseId:null,kind:'legacy_unclassified',title:'فرصة قديمة'}]});
    assert.equal(button('إرسال للتحقق').disabled,true);
    await select(fields('الدورة المهتم بها')[0],'c1');
    await select(fields('الدفعة')[0],'c1-run');
    await select(fields('موعد حضور الدورة')[0],'c1-s2');
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c1');
    assert.equal(button('إرسال للتحقق').disabled,false);
    assert.equal(doc.querySelector('form').checkValidity(),true);
    const before=writes.length;
    await click(button('إرسال للتحقق'));
    assert.equal(writes.length,before+1);
    assert.equal(writes.at(-1).p_opportunity_id,'old-sale');
    assert.equal(writes.at(-1).p_payment_course_id,'c1');
    assert.deepEqual(writes.at(-1).p_course_interests,[{courseId:'c1',courseRunId:'c1-run',attendanceSessionId:'c1-s2'}]);
  });
  await t.test('automatic general intake offers the selected course and submits the same opportunity',async()=>{
    await mountPaymentCase('automatic-general',{courseInterests:[],openOpportunities:[{id:'intake-sale',courseId:null,kind:'general',canBindPaymentCourse:true,title:'فرصة تلقائية'}]});
    await select(fields('الدورة المهتم بها')[0],'c1');
    await select(fields('الدفعة')[0],'c1-run');
    await select(fields('موعد حضور الدورة')[0],'c1-s2');
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c1');
    assert.equal(doc.querySelector('form').checkValidity(),true);
    assert.equal(button('إرسال للتحقق').disabled,false);
    const before=writes.length;
    await click(button('إرسال للتحقق'));
    assert.equal(writes.length,before+1);
    assert.equal(writes.at(-1).p_opportunity_id,'intake-sale');
    assert.equal(writes.at(-1).p_payment_course_id,'c1');
    assert.deepEqual(writes.at(-1).p_course_interests,[{courseId:'c1',courseRunId:'c1-run',attendanceSessionId:'c1-s2'}]);
  });
  await t.test('multiple interests require an explicit payment course and track changed course rows',async()=>{
    await mountPaymentCase('legacy-multiple',{courseInterests:[{courseId:'c1'},{courseId:'c2'}],openOpportunities:[{id:'old-sale',courseId:null,kind:'legacy_unclassified',title:'فرصة قديمة'}]});
    const payment=fields('الدورة التي يخصها بلاغ الدفع')[0];
    assert.deepEqual([...payment.options].map(option=>option.value),['','c1','c2']);
    assert.equal(payment.value,'');
    assert.equal(doc.querySelector('form').checkValidity(),false);
    await select(payment,'c2');
    await click(button('إرسال للتحقق'));
    assert.equal(writes.at(-1).p_payment_course_id,'c2');
    await select(fields('الدورة المهتم بها')[1],'c3');
    assert.equal(payment.value,'');
    assert.equal([...payment.options].some(option=>option.value==='c2'),false);
  });
  await t.test('a bound course changes only after explicit selection, carrying the new batch and session atomically',async()=>{
    await mountPaymentCase('replace-course',{courseInterests:[{courseId:'c1',courseRunId:'c1-run',attendanceSessionId:'c1-s1'}],
      openOpportunities:[{id:'bound-sale',courseId:'c1',courseName:'دورة أولى',kind:'legacy_unclassified',canChangeCourse:true}]});
    await select(fields('الدورة المهتم بها')[0],'c2');
    assert.equal(fields('الدفعة')[0].value,'');
    assert.equal(fields('موعد حضور الدورة')[0].value,'');
    assert.equal(button('إرسال للتحقق').disabled,true);
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].options.length,1);
    await select(fields('تغيير دورة الفرصة الحالية')[0],'c2');
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c2');
    assert.match(doc.body.textContent,/ستُستبدل دورة نفس الفرصة/);
    await select(fields('الدفعة')[0],'c2-run');
    await select(fields('موعد حضور الدورة')[0],'c2-s2');
    assert.equal(doc.querySelector('form').checkValidity(),true);
    const before=writes.length;
    await click(button('إرسال للتحقق'));
    assert.equal(writes.length,before+1);
    assert.equal(writes.at(-1).p_opportunity_id,'bound-sale');
    assert.equal(writes.at(-1).p_opportunity_course_id,'c2');
    assert.equal(writes.at(-1).p_payment_course_id,'c2');
    assert.deepEqual(writes.at(-1).p_course_interests,[{courseId:'c2',courseRunId:'c2-run',attendanceSessionId:'c2-s2'}]);
    await select(fields('الدورة المهتم بها')[0],'c3');
    assert.equal(button('إرسال للتحقق').disabled,true);
    assert.match(doc.body.textContent,/الدورة الجديدة لم تعد متاحة/);
    await select(fields('تغيير دورة الفرصة الحالية')[0],'');
    assert.equal(button('إرسال للتحقق').disabled,true);
  });
  await t.test('changing opportunity clears the replacement intent and does not leak it to another sale',async()=>{
    await mountPaymentCase('replace-switch',{courseInterests:[{courseId:'c1'},{courseId:'c2'},{courseId:'c3'}],openOpportunities:[
      {id:'first',courseId:'c1',kind:'training',canChangeCourse:true},
      {id:'second',courseId:'c3',kind:'training',canChangeCourse:true}
    ]});
    await select(fields('الفرصة التي تخصها المتابعة')[0],'first');
    await select(fields('تغيير دورة الفرصة الحالية')[0],'c2');
    await select(fields('الفرصة التي تخصها المتابعة')[0],'second');
    assert.equal(fields('تغيير دورة الفرصة الحالية')[0].value,'');
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c3');
    await click(button('إرسال للتحقق'));
    assert.equal(writes.at(-1).p_opportunity_id,'second');
    assert.equal(Object.hasOwn(writes.at(-1),'p_opportunity_course_id'),false);
  });
  await t.test('bound opportunities keep course isolation and explain a mismatch',async()=>{
    await mountPaymentCase('bound',{courseInterests:[{courseId:'c2'}],openOpportunities:[{id:'bound-sale',courseId:'c1',kind:'training',title:'فرصة دورة أولى'}]});
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].options.length,1);
    assert.equal(button('إرسال للتحقق').disabled,true);
    assert.match(doc.body.textContent,/أضف دورة الفرصة/);
    await click(button('إضافة دورة'));
    await select(fields('الدورة المهتم بها')[1],'c1');
    assert.equal(fields('الدورة التي يخصها بلاغ الدفع')[0].value,'c1');
    assert.deepEqual([...fields('الدورة التي يخصها بلاغ الدفع')[0].options].map(option=>option.value),['','c1']);
  });
  await t.test('explicit general opportunities cannot be silently converted into training sales',async()=>{
    await mountPaymentCase('general',{openOpportunities:[{id:'general-sale',courseId:null,kind:'general',title:'استفسار عام'}]});
    assert.equal(button('إرسال للتحقق').disabled,true);
    assert.match(doc.body.textContent,/هذه فرصة عامة/);
    const before=writes.length;
    await click(button('إرسال للتحقق'));
    assert.equal(writes.length,before);
  });
});
