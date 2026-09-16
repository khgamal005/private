import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';

const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),modules=new Map();
const router={refresh(){},push(){}};
function load(path){
  const file=resolve(root,path);if(modules.has(file))return modules.get(file).exports;
  const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
  const componentModule={exports:{}};modules.set(file,componentModule);
  const localRequire=name=>{
    if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
    if(name==='next/navigation')return {useRouter:()=>router};
    if(name==='next/link')return {__esModule:true,default:({children,...props})=>React.createElement('a',props,children)};
    if(name.startsWith('.')){const target=resolve(dirname(file),name),found=[target,...['.tsx','.ts','.js','.mjs'].map(extension=>target+extension)].find(existsSync);assert.ok(found,`dependency ${name}`);return load(found);}
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:file})(localRequire,componentModule,componentModule.exports);return componentModule.exports;
}
const unit={id:'unit-1',title:'الدرس الحقيقي',kind:'text',required:true,minimumSeconds:0,position:1};
const enrollment={id:'enrollment-1',studentId:'student-1',studentName:'متدرب الاختبار',courseId:'course-1',courseTitle:'الدورة الحقيقية',runId:'run-1',runTitle:'الدفعة الأولى',status:'confirmed',versionId:'version-1',units:[unit],financialAccess:{trainingAllowed:true,certificationAllowed:false,financialStatus:'settled',reasonCodes:[],currency:'SAR'},progress:{completedUnits:0,totalUnits:1,percent:0},sessions:[{id:'session-1',title:'اللقاء المباشر',startsAt:'2026-09-20T10:00Z',joinUrl:'https://example.test/meeting'}]};
const learner={role:'learner',tenant:{id:'3d185482-b916-49cc-b868-b6dfdb93eba8',slug:'marktone',name:'مركز الاختبار',timezone:'Asia/Riyadh'},viewer:{},learning:{role:'learner',courses:[],enrollments:[enrollment],submissions:[],requests:[]}};
async function mounted(data,fn,{view='learning',respond=()=>({ok:true,json:async()=>({data:{unit:{...unit,body:'محتوى خاص مسموح لهذا المتدرب'}}})})}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://odeir.com/learn/marktone'}),previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const originalFetch=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return respond(calls.length,calls.at(-1));};
  const {createRoot}=await import('react-dom/client'),app=createRoot(document.getElementById('app')),Component=load('components/training-journey-workspace.tsx').default;
  const render=async(initialData)=>act(async()=>app.render(React.createElement(Component,{slug:'marktone',initialData,initialView:view})));
  const button=text=>[...document.querySelectorAll('button')].find(x=>x.textContent.includes(text));
  const click=async text=>{const b=button(text);assert.ok(b,`button ${text}`);assert.equal(b.disabled,false,`enabled ${text}`);await act(async()=>b.click());};
  try{await render(data);await fn({doc:document,dom,render,button,click,calls});assert.equal(localStorage.length,0);assert.equal(sessionStorage.length,0);}
  finally{await act(async()=>app.unmount());dom.window.close();globalThis.fetch=originalFetch;for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
}

async function change(node,value){assert.ok(node);const proto=node.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:node.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));node.dispatchEvent(new window.Event('change',{bubbles:true}));});}
async function submit(form){assert.ok(form);await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));}
const response=data=>({ok:true,json:async()=>({data})});

function rolloutSnapshot({enabled=false,role='manager',canConfigureAutomation=true}={}){
 const capabilities={canManage:true,canVerifyPayments:true,canApproveCredit:true,canConfigureAutomation};
 return {...learner,role,viewer:{...capabilities},learning:null,operations:{enabled,settings:{graceDays:7,timezone:'Asia/Riyadh'},handoffs:[],enrollments:[],invoices:[],payments:[],runs:[],staff:[],requests:[],tasks:[],capabilities}};
}

test('permitted owner activates disabled training only through the authenticated command endpoint',async()=>{
 await mounted(rolloutSnapshot(),async({doc,click,calls})=>{
  assert.match(doc.body.textContent,/تفعيل رحلة التدريب لمركز ماركتون/);assert.equal(calls.length,0);
  await click('تفعيل التشغيل المتكامل');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/training/set_enabled');
  assert.equal(calls[0].body.tenantSlug,'marktone');assert.deepEqual(calls[0].body.payload,{enabled:true});
  assert.match(calls[0].body.commandId,/^[0-9a-f-]{36}$/);assert.match(doc.querySelector('[role="status"]').textContent,/تم تفعيل رحلة التدريب/);
 },{view:'overview',respond:()=>response({success:true,enabled:true})});
});

test('finance-only staff, learners and instructors receive no rollout activation or rollback controls',async()=>{
 for(const options of [{canConfigureAutomation:false},{role:'learner'},{role:'instructor'}]){
  for(const enabled of [false,true])await mounted(rolloutSnapshot({...options,enabled}),async({button,calls})=>{
   assert.equal(button('تفعيل التشغيل المتكامل'),undefined);assert.equal(button('إيقاف التشغيل المتكامل'),undefined);assert.equal(calls.length,0);
  },{view:'tasks'});
 }
});

test('permitted owner can disable the journey from operational tasks with history preservation explained',async()=>{
 await mounted(rolloutSnapshot({enabled:true}),async({doc,button,click,calls})=>{
  assert.equal(button('تفعيل التشغيل المتكامل'),undefined);assert.match(doc.body.textContent,/الاحتفاظ بالتسجيلات والمدفوعات والمحتوى والتقدم المحفوظ/);
  await click('إيقاف التشغيل المتكامل مع حفظ السجل');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/training/set_enabled');
  assert.equal(calls[0].body.tenantSlug,'marktone');assert.deepEqual(calls[0].body.payload,{enabled:false});assert.ok(calls[0].body.commandId);
 },{view:'tasks',respond:()=>response({success:true,enabled:false})});
});

test('learner quiz and assignment submit only enrollment identity and answers to authorized action',async()=>{
 const quiz={...unit,kind:'quiz',title:'اختبار التطبيق'},assignment={...unit,id:'unit-2',kind:'assignment',title:'واجب التطبيق'};const data={...learner,learning:{...learner.learning,enrollments:[{...enrollment,units:[quiz,assignment]}]}};
 await mounted(data,async({doc,click,calls})=>{await click('اختبار التطبيق');await act(async()=>doc.querySelectorAll('input[type="radio"]')[1].click());await submit(doc.querySelector('form'));assert.equal(calls[1].url,'/api/training/submit_quiz');assert.deepEqual(calls[1].body.payload,{enrollmentId:'enrollment-1',unitId:'unit-1',answers:{q1:1}});assert.match(doc.body.textContent,/اجتزت الاختبار/);await click('واجب التطبيق');await change(doc.querySelector('textarea'),'هذا تطبيق عملي يوضح تسلسل العمل كاملًا.');await submit(doc.querySelector('form'));assert.equal(calls[3].url,'/api/training/submit_assignment');assert.equal(calls[3].body.payload.body,'هذا تطبيق عملي يوضح تسلسل العمل كاملًا.');assert.equal(calls[3].body.payload.studentId,undefined);},{respond:(_,call)=>call.url.endsWith('open_unit')?response({unit:call.body.payload.unitId==='unit-1'?{...quiz,body:'اختر الإجابة.',questions:[{id:'q1',prompt:'أي خطوة؟',options:['أ','ب']}],passPercent:70,maxAttempts:3}:{...assignment,body:'نفذ المطلوب.'}}):call.url.endsWith('submit_quiz')?response({score:100,passed:true,attempt:1}):response({submissionId:'sub-1'})});
});

test('pagination retains actual role and requests next server page without simulated rows',async()=>{
 const data={...learner,role:'instructor',learning:{...learner.learning,role:'instructor',pagination:{offset:0,limit:50,hasMore:true}}};
 await mounted(data,async({doc,click,calls})=>{await click('الصفحة التالية');assert.deepEqual(calls[0].body,{tenantSlug:'marktone',payload:{role:'instructor',offset:50}});assert.equal(calls[0].url,'/api/training/snapshot');assert.equal(doc.body.textContent.includes('الدورة الحقيقية'),false);assert.equal(doc.body.textContent.includes('القبول والسداد'),false);},{view:'overview',respond:()=>response({...data,learning:{...data.learning,enrollments:[],pagination:{offset:50,limit:50,hasMore:false}}})});
});

test('authoring fetches full latest draft, forbids older metadata draft edits, and invalidates focus after refresh',async()=>{
 const policy={minAttendancePercent:75,minAssessmentPercent:70,requireCompletedRun:true,certificateEnabled:true,termsVersion:'v1',supportEmail:'support@example.com'};
 const versions=[{id:'version-2',version:2,title:'أحدث مسودة',status:'draft',learningMode:'blended',policy,units:[]},{id:'version-1',version:1,title:'مسودة أقدم',status:'draft',learningMode:'blended',policy,units:[]}];
 const data={...learner,role:'manager',viewer:{canManage:true},learning:{...learner.learning,role:'manager',courses:[{id:'course-1',title:'دورة التحرير',versions}]}};
 const detail=structuredClone(data);detail.learning.courses[0].versions[0].units=[{...unit,body:'نص محفوظ يجب ألا يُمسح'}];
 await mounted(data,async({doc,click,button,calls,render})=>{assert.equal(button('حفظ المسودة'),undefined);await click('فتح محرر المحتوى');assert.deepEqual(calls[0].body.payload,{role:'manager',courseId:'course-1',offset:0});assert.ok(button('حفظ المسودة'));assert.match(doc.querySelector('textarea').value,/نص محفوظ/);await change(doc.querySelectorAll('select')[1],'version-1');assert.equal(button('حفظ المسودة'),undefined,'older draft has metadata only and cannot be saved');assert.match(doc.body.textContent,/إصدار محفوظ/);await change(doc.querySelectorAll('select')[1],'latest');assert.ok(button('حفظ المسودة'));await render(structuredClone(data));assert.equal(button('حفظ المسودة'),undefined,'server refresh metadata invalidates full-content focus');assert.ok(button('فتح محرر المحتوى'));},{view:'content',respond:()=>response(detail)});
});

test('payment linkage follows explicit confirmation capability, without fabricated redacted totals',async()=>{
 const operations={enabled:true,settings:{graceDays:7,timezone:'Asia/Riyadh'},handoffs:[{id:'handoff-1',contactId:'contact-1',contactName:'عميل مؤكد',courseId:'course-1',courseTitle:'دورة',status:'pending',paymentStatus:'pending_verification',financial:{trainingAllowed:false,certificationAllowed:false,financialStatus:'pending',reasonCodes:['invoice_link_required']}}],enrollments:[],invoices:[],payments:[],runs:[],staff:[],requests:[],tasks:[],capabilities:{canManage:false,canVerifyPayments:true,canApproveCredit:false}};
 const data={...learner,role:'manager',learning:null,operations};
 await mounted(data,async({doc})=>{assert.match(doc.body.textContent,/ربط الفاتورة وسياسة السداد/);assert.equal(doc.body.textContent.includes('المبلغ المؤكد'),false);assert.equal(doc.body.textContent.includes('المتبقي'),false);},{view:'admissions'});
});

test('learner can read actual submitted work and instructor feedback without grading controls',async()=>{
 const data={...learner,learning:{...learner.learning,submissions:[{id:'sub-1',enrollmentId:'enrollment-1',unitId:'unit-2',unitTitle:'تطبيق العمل',body:'الإجابة الأصلية',submittedAt:'2026-09-16T10:00:00Z',grade:{score:82,feedback:'راجع ترتيب خطوات التنفيذ.'}}]}};
 await mounted(data,async({doc,button,calls})=>{assert.match(doc.body.textContent,/الإجابة الأصلية/);assert.match(doc.body.textContent,/راجع ترتيب خطوات التنفيذ/);assert.equal(button('حفظ التقييم'),undefined);assert.equal(calls.length,0);},{view:'requests'});
});

test('external resource links allow HTTPS without credentials and reject script/data schemes',()=>{
 const {safeTrainingExternalUrl}=load('lib/training-journey-contract.ts');for(const bad of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:pass@example.com'])assert.equal(safeTrainingExternalUrl(bad),null);assert.equal(safeTrainingExternalUrl('https://example.com/resource'),'https://example.com/resource');
});

test('finance-only managers can page fifty handoffs without a learning snapshot and return to the first page',async()=>{
 const operations={enabled:true,offset:0,pageSize:50,settings:{graceDays:7,timezone:'Asia/Riyadh'},handoffs:Array.from({length:50},(_,index)=>({id:`handoff-${index}`,contactId:`contact-${index}`,contactName:`عميل الصفحة الأولى ${index}`,courseId:'course-1',courseTitle:'دورة',status:'pending',paymentStatus:'pending_verification'})),enrollments:[],invoices:[],payments:[],runs:[],staff:[],requests:[],tasks:[],capabilities:{canManage:false,canVerifyPayments:false,canApproveCredit:false}};
 const data={...learner,role:'manager',viewer:{canManageLearning:false},learning:null,operations};
 await mounted(data,async({doc,click,button,calls,render})=>{assert.ok(button('الصفحة التالية'));await click('الصفحة التالية');assert.deepEqual(calls[0].body,{tenantSlug:'marktone',payload:{role:'manager',offset:50}});assert.match(doc.body.textContent,/عميل الصفحة الثانية/);assert.equal(button('الصفحة التالية').disabled,true);assert.equal(button('الصفحة السابقة').disabled,false);await click('الصفحة السابقة');assert.equal(calls[1].body.payload.offset,0);assert.match(doc.body.textContent,/عميل الصفحة الأولى/);await render({...data,operations:{...operations,hasMore:false}});assert.equal(button('الصفحة التالية').disabled,true,'an accurate server false overrides the bounded-list fallback');},{view:'admissions',respond:(_,call)=>response(call.body.payload.offset===50?{...data,operations:{...operations,offset:50,handoffs:[{...operations.handoffs[0],id:'handoff-50',contactName:'عميل الصفحة الثانية'}]}}:data)});
});

test('extra invoice/payment/run options are merged by ID without replacing the current handoff page',async()=>{
 const firstHandoff={id:'handoff-first',contactId:'contact-1',contactName:'طلب التسجيل الذي يجب الاحتفاظ به',courseId:'course-1',courseTitle:'دورة',status:'pending',paymentStatus:'pending_verification'};
 const invoices=Array.from({length:50},(_,index)=>({id:`invoice-${index}`,number:`INV-${index}`,customerAccountId:`payer-${index}`,customerName:`دافع ${index}`,totalMinor:10000,currency:'SAR'}));
 const operations={enabled:true,offset:0,pageSize:50,settings:{graceDays:7,timezone:'Asia/Riyadh'},handoffs:[firstHandoff],enrollments:[],invoices,payments:[],runs:[],staff:[],requests:[],tasks:[],capabilities:{canManage:false,canVerifyPayments:true,canApproveCredit:false}};
 const data={...learner,role:'manager',viewer:{canManageLearning:false},learning:null,operations};
 const later={...data,operations:{...operations,offset:50,handoffs:[{...firstHandoff,id:'handoff-other',contactName:'طلب آخر يجب ألا يظهر'}],invoices:[invoices[0],{id:'invoice-50',number:'INV-TARGET',customerAccountId:'payer-target',customerName:'الشركة المطلوبة',totalMinor:25000,currency:'SAR'}],payments:[{id:'payment-target',number:'PAY-TARGET',customerAccountId:'payer-target',amountMinor:25000,status:'pending_verification'}],runs:[{id:'run-target',courseId:'course-1',title:'الدفعة المطلوبة',status:'open'}]}};
 await mounted(data,async({doc,click,calls,button,render})=>{assert.equal(button('الصفحة التالية').disabled,true,'full invoice options do not force an unrelated handoff page');await click('تحميل خيارات إضافية');assert.deepEqual(calls[0].body.payload,{role:'manager',offset:50});assert.match(doc.body.textContent,/طلب التسجيل الذي يجب الاحتفاظ به/);assert.doesNotMatch(doc.body.textContent,/طلب آخر يجب ألا يظهر/);const invoiceSelect=doc.querySelector('select');assert.equal(invoiceSelect.querySelectorAll('option[value="invoice-0"]').length,1,'options are deduplicated');assert.ok(invoiceSelect.querySelector('option[value="invoice-50"]'));await change(invoiceSelect,'invoice-50');assert.match(doc.body.textContent,/PAY-TARGET/);assert.equal(button('تحميل خيارات إضافية'),undefined,'bounded shorter next page ends option pagination');await render(structuredClone(data));assert.equal(doc.querySelector('option[value="invoice-50"]'),null,'new server props invalidate accumulated options');},{view:'admissions',respond:()=>response(later)});
});

test('handoffs on later pages can load earlier invoice options before continuing forward',async()=>{
 const currentInvoice={id:'invoice-current',number:'INV-CURRENT',customerAccountId:'payer-current',customerName:'دافع الصفحة الحالية',totalMinor:10000,currency:'SAR'};
 const operations={enabled:true,offset:50,pageSize:50,settings:{graceDays:7,timezone:'Asia/Riyadh'},handoffs:[{id:'handoff-later',contactId:'contact-later',contactName:'طلب محفوظ من الصفحة الثانية',courseId:'course-1',courseTitle:'دورة',status:'pending',paymentStatus:'pending_verification'}],enrollments:[],invoices:[currentInvoice],payments:[],runs:[],staff:[],requests:[],tasks:[],capabilities:{canManage:false,canVerifyPayments:true,canApproveCredit:false}};
 const data={...learner,role:'manager',viewer:{canManageLearning:false},learning:null,operations};
 const invoicePage=offset=>Array.from({length:50},(_,index)=>({id:`invoice-${offset+index}`,number:`INV-${offset+index}`,customerAccountId:`payer-${offset+index}`,customerName:`دافع ${offset+index}`,totalMinor:10000,currency:'SAR'}));
 await mounted(data,async({doc,click,button,calls})=>{assert.ok(button('تحميل خيارات إضافية'),'earlier options remain reachable despite short current option arrays');await click('تحميل خيارات إضافية');assert.equal(calls[0].body.payload.offset,0);assert.ok(doc.querySelector('option[value="invoice-0"]'),'earlier invoice is selectable');assert.ok(doc.querySelector('option[value="invoice-current"]'),'existing current-page options retained');assert.match(doc.body.textContent,/طلب محفوظ من الصفحة الثانية/);await click('تحميل خيارات إضافية');assert.equal(calls[1].body.payload.offset,50);await click('تحميل خيارات إضافية');assert.equal(calls[2].body.payload.offset,100);assert.match(doc.body.textContent,/طلب محفوظ من الصفحة الثانية/);assert.equal(button('تحميل خيارات إضافية'),undefined);},{view:'admissions',respond:(_,call)=>response({...data,operations:{...operations,offset:call.body.payload.offset,handoffs:[],invoices:call.body.payload.offset<100?invoicePage(call.body.payload.offset):[],payments:[],runs:[]}})});
});
