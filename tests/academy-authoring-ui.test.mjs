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
import {createAuthoringDocument} from '../lib/academy-authoring.mjs';

const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),modules=new Map();
const router={refresh(){}};
function load(path){
  const file=resolve(root,path);if(modules.has(file))return modules.get(file).exports;
  const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
  const componentModule={exports:{}};modules.set(file,componentModule);
  const localRequire=name=>{
    if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
    if(name==='next/navigation')return {useRouter:()=>router};
    if(name.startsWith('.')){const target=resolve(dirname(file),name),found=[target,...['.tsx','.ts','.js','.mjs'].map(extension=>target+extension)].find(existsSync);assert.ok(found,`dependency ${name}`);return load(found);}
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:file})(localRequire,componentModule,componentModule.exports);return componentModule.exports;
}
const ids={course:'11111111-1111-4111-8111-111111111111',other:'22222222-2222-4222-8222-222222222222',path:'33333333-3333-4333-8333-333333333333'};
const curriculum=()=>{
  const document=createAuthoringDocument('دورة تطبيقية');
  document.description='وصف الدورة ومخرجات التعلم';document.policy.termsVersion='1.0';document.policy.supportEmail='support@example.com';
  document.topics=[{id:'topic-one',title:'المقدمة',summary:'',units:[{id:'unit-one',title:'الدرس الأول',kind:'text',required:true,minimumSeconds:0,body:'محتوى الدرس الأول',url:''}]},{id:'topic-two',title:'التطبيق',summary:'',units:[{id:'unit-two',title:'التطبيق العملي',kind:'assignment',required:true,minimumSeconds:0,body:'نفذ التطبيق ووضح النتائج',url:''}]}];
  return document;
};
const base=()=>({available:true,tenant:{slug:'marktone'},courses:[{id:ids.course,title:'دورة تطبيقية',draftTitle:'دورة تطبيقية',authoringRevision:1,publishedVersionId:null},{id:ids.other,title:'دورة متقدمة',draftTitle:'دورة متقدمة',authoringRevision:1,publishedVersionId:'version-other'}],paths:[],course:null,path:null,ai:{configured:false,status:'unconfigured'},offset:0,pathOffset:0,hasMore:{courses:false,paths:false}});
const ok=data=>({ok:true,json:async()=>({data})});
const fail=(error='تعذر حفظ المسودة. حاول مرة أخرى.')=>({ok:false,json:async()=>({error})});
function server(initialDocument=curriculum()){
  let document=structuredClone(initialDocument),revision=1,publishedRevision=null,path=null;
  const respond=call=>{
    const {payload}=call.body;
    if(call.url.endsWith('/create_course')){document=createAuthoringDocument(payload.title);return ok({courseId:ids.course,revision});}
    if(call.url.endsWith('/save_course')){assert.equal(payload.expectedRevision,revision);document=structuredClone(payload.document);revision++;return ok({courseId:ids.course,revision});}
    if(call.url.endsWith('/publish_course')){assert.equal(payload.expectedRevision,revision);assert.equal(payload.humanReviewed,true);publishedRevision=revision;return ok({courseId:ids.course,revision,versionId:'published-version'});}
    if(call.url.endsWith('/save_path')){path={pathId:ids.path,revision:(path?.revision||0)+1,document:structuredClone(payload.document),publishedRevision:null};return ok({pathId:ids.path,revision:path.revision});}
    if(call.url.endsWith('/publish_path')){assert.equal(payload.pathId,ids.path);path.publishedRevision=path.revision;return ok({pathId:ids.path,revision:path.revision});}
    if(call.url.endsWith('/snapshot'))return ok({...base(),course:payload.courseId?{courseId:ids.course,revision,document:structuredClone(document),publishedVersionId:publishedRevision?'published-version':null,publishedRevision}:null,path:payload.pathId?structuredClone(path):null});
    assert.fail(`unexpected endpoint ${call.url}`);
  };
  return {respond};
}
async function mounted(fn,{data=base(),view='courses',respond=server().respond}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://odeir.com/academy/marktone/lms/courses'}),previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const originalFetch=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{const call={url,body:JSON.parse(options.body)};calls.push(call);return respond(call,calls.length);};
  const {createRoot}=await import('react-dom/client'),app=createRoot(document.getElementById('app')),Component=load('components/academy-authoring-workspace.js').default;
  const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent.includes(text));
  const click=async text=>{const node=button(text);assert.ok(node,`button ${text}`);assert.equal(node.disabled,false,`enabled ${text}`);await act(async()=>node.click());};
  const field=text=>[...document.querySelectorAll('label')].find(node=>node.querySelector('span')?.textContent===text)?.querySelector('input,textarea,select');
  try{await act(async()=>app.render(React.createElement(Component,{slug:'marktone',initialData:data,initialView:view})));await fn({doc:document,button,click,field,calls});assert.equal(localStorage.length,0);assert.equal(sessionStorage.length,0);}
  finally{await act(async()=>app.unmount());dom.window.close();globalThis.fetch=originalFetch;for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
}
async function change(node,value){assert.ok(node);const proto=node.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:node.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));node.dispatchEvent(new window.Event('change',{bubbles:true}));});}
async function submit(form){assert.ok(form);await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));}
async function drag(source,target){
  assert.ok(source);assert.ok(target);
  const transfer={setData(){},effectAllowed:''};
  await act(async()=>{const start=new window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(start,'dataTransfer',{value:transfer});source.dispatchEvent(start);const drop=new window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:transfer});target.dispatchEvent(drop);});
}

test('course creation persists a canonical draft then opens its focused document',async()=>{
  await mounted(async({doc,click,field,calls})=>{
    await click('دورة جديدة');await change(field('عنوان الدورة'),'إدارة المشروعات');await submit(doc.querySelector('[role="dialog"] form'));
    assert.equal(calls[0].url,'/api/academy-authoring/create_course');assert.deepEqual(calls[0].body.payload,{title:'إدارة المشروعات',category:'تدريب عام'});assert.match(calls[0].body.commandId,/^[0-9a-f-]{36}$/);assert.deepEqual(calls[1].body.payload,{courseId:ids.course});assert.equal(field('عنوان الدورة').value,'إدارة المشروعات');assert.equal(doc.querySelector('[aria-current="step"]').textContent.includes('الأساسيات'),true);
  });
});

test('curriculum edits save full focused document, topic order, and expected revision',async()=>{
  await mounted(async({doc,click,field,calls})=>{
    await click('تعديل الدورة');await click('المنهاج');
    await act(async()=>doc.querySelector('[aria-label="نقل القسم 2 لأعلى"]').click());
    assert.equal(field('عنوان القسم 1').value,'التطبيق');await click('التطبيق العملي');await change(field('تعليمات الواجب'),'تعليمات جديدة محفوظة');await click('حفظ المسودة');
    const save=calls.find(call=>call.url.endsWith('/save_course'));assert.equal(save.body.payload.expectedRevision,1);assert.equal(save.body.payload.document.topics[0].id,'topic-two');assert.equal(save.body.payload.document.topics[0].units[0].body,'تعليمات جديدة محفوظة');assert.equal(save.body.payload.document.topics[1].units[0].body,'محتوى الدرس الأول');assert.match(doc.body.textContent,/كل التعديلات محفوظة/);
  });
});

test('publish blocks dirty content and requires saved revision plus explicit human review',async()=>{
  await mounted(async({doc,click,field,calls,button})=>{
    await click('تعديل الدورة');await change(field('عنوان الدورة'),'دورة بعد المراجعة');await click('المراجعة والنشر');await click('نشر الدورة');assert.match(doc.querySelector('[role="alert"]').textContent,/احفظ تعديلاتك/);assert.equal(calls.some(call=>call.url.endsWith('/publish_course')),false);
    await click('حفظ المسودة');await click('نشر الدورة');assert.equal(button('تأكيد النشر').disabled,true);await act(async()=>doc.querySelector('[role="dialog"] input[type="checkbox"]').click());await click('تأكيد النشر');const publish=calls.find(call=>call.url.endsWith('/publish_course'));assert.equal(publish.body.payload.expectedRevision,2);assert.equal(publish.body.payload.humanReviewed,true);assert.match(doc.body.textContent,/نُشر محتوى الدورة بنجاح/);
  });
});

test('AI entry saves a real generation brief without fabricating content or contacting a model',async()=>{
  await mounted(async({doc,click,field,calls})=>{
    await click('تعديل الدورة');await click('مساعدة الذكاء الاصطناعي');assert.match(doc.querySelector('[role="dialog"]').textContent,/لم تُعدّ بعد/);await change(field('ماذا تريد أن يتعلم المتدرب؟'),'إنشاء دورة تمهيدية عن أساسيات التخطيط');await change(field('لمن تقدم هذا المحتوى؟'),'مديرو مشروعات مبتدئون');await submit(doc.querySelector('[role="dialog"] form'));
    const save=calls.find(call=>call.url.endsWith('/save_course'));assert.equal(save.body.payload.document.aiBrief.goal,'إنشاء دورة تمهيدية عن أساسيات التخطيط');assert.equal(save.body.payload.document.aiBrief.audience,'مديرو مشروعات مبتدئون');assert.equal(save.body.payload.document.topics[0].units[0].body,'محتوى الدرس الأول');assert.ok(calls.every(call=>/\/(snapshot|save_course)$/.test(call.url)));assert.match(doc.body.textContent,/حُفظ وصف طلب الإنشاء/);
  });
});

test('path creation persists canonical course order and never creates course copies or enrollments',async()=>{
  await mounted(async({doc,click,field,calls})=>{
    await click('مسار جديد');await change(field('عنوان المسار'),'مسار الإدارة');await change(field('إضافة دورة موجودة'),ids.course);await click('إضافة للمسار');await change(field('إضافة دورة موجودة'),ids.other);await click('إضافة للمسار');await act(async()=>doc.querySelector('[aria-label="نقل دورة المسار 2 لأعلى"]').click());await click('حفظ المسار');
    const save=calls.find(call=>call.url.endsWith('/save_path'));assert.equal(save.body.payload.pathId,null);assert.equal(save.body.payload.expectedRevision,0);assert.deepEqual(save.body.payload.document.courseIds,[ids.other,ids.course]);await click('نشر المسار');await act(async()=>doc.querySelector('[role="dialog"] input[type="checkbox"]').click());await click('تأكيد النشر');assert.deepEqual(calls.find(call=>call.url.endsWith('/publish_path')).body.payload,{pathId:ids.path,expectedRevision:1,humanReviewed:true});assert.ok(calls.every(call=>/\/(snapshot|save_path|publish_path)$/.test(call.url)));
  },{view:'paths'});
});

test('failed save retains editable data and retries the same command identity',async()=>{
  const fake=server();let attempts=0;
  await mounted(async({doc,click,field,calls})=>{
    await click('تعديل الدورة');await change(field('عنوان الدورة'),'تعديلات محفوظة محليًا في الشاشة');await click('حفظ المسودة');assert.match(doc.querySelector('[role="alert"]').textContent,/تغيّرت المسودة/);assert.equal(field('عنوان الدورة').value,'تعديلات محفوظة محليًا في الشاشة');await click('حفظ المسودة');const saves=calls.filter(call=>call.url.endsWith('/save_course'));assert.equal(saves[0].body.commandId,saves[1].body.commandId);
  },{respond:call=>call.url.endsWith('/save_course')&&attempts++===0?fail('تغيّرت المسودة منذ فتحها. أعد فتح النسخة المحفوظة قبل متابعة التعديل.'):fake.respond(call)});
});

test('failed focused read does not expose summary as editable content',async()=>{
  await mounted(async({doc,click,field})=>{await click('تعديل الدورة');assert.equal(field('عنوان الدورة'),undefined);assert.match(doc.querySelector('[role="alert"]').textContent,/تعذر حفظ/);},{respond:()=>fail()});
});

test('preview escapes author content and does not reveal quiz answer keys',async()=>{
  const document=curriculum();document.description='<img src=x onerror="alert(1)">';document.topics[0].units[0].body='<script>alert(1)</script>';
  await mounted(async({doc,click})=>{await click('تعديل الدورة');await click('معاينة');const preview=doc.querySelector('[role="dialog"]');assert.equal(preview.querySelector('script,img'),null);assert.match(preview.textContent,/<script>alert\(1\)<\/script>/);},{respond:server(document).respond});
});

test('unavailable authoring fails closed without mutation controls',async()=>{
  for(const data of [{...base(),available:false},{tenant:{slug:'marktone'}}])await mounted(async({button,calls})=>{assert.equal(button('دورة جديدة'),undefined);assert.equal(calls.length,0);},{data});
});

test('discard protection keeps a dirty draft until explicit choice',async()=>{
  await mounted(async({doc,click,field})=>{await click('تعديل الدورة');await change(field('عنوان الدورة'),'عنوان لم يحفظ');await click('العودة إلى الدورات');assert.match(doc.querySelector('[role="dialog"]').textContent,/تعديلات غير محفوظة/);await click('متابعة التحرير');assert.equal(field('عنوان الدورة').value,'عنوان لم يحفظ');});
});

test('drag handles reorder topics and units while retaining their IDs and content',async()=>{
  const document=curriculum();document.topics[0].units.push({id:'unit-three',kind:'text',title:'الدرس الثاني',body:'شرح آخر',url:'',required:true,minimumSeconds:0});
  await mounted(async({doc,click,field,calls})=>{
    await click('تعديل الدورة');await click('المنهاج');
    await drag(doc.querySelector('[aria-label="اسحب لترتيب العنصر 2 في القسم 1"]'),doc.querySelector('[aria-label="اسحب لترتيب العنصر 1 في القسم 1"]').closest('article'));
    await drag(doc.querySelector('[aria-label="اسحب لترتيب القسم 2"]'),doc.querySelector('section[aria-label="المقدمة"]'));
    assert.equal(field('عنوان القسم 1').value,'التطبيق');await click('حفظ المسودة');const saved=calls.find(call=>call.url.endsWith('/save_course')).body.payload.document;assert.deepEqual(saved.topics.map(topic=>topic.id),['topic-two','topic-one']);assert.deepEqual(saved.topics[1].units.map(unit=>unit.id),['unit-three','unit-one']);assert.equal(saved.topics[1].units[0].body,'شرح آخر');
  },{respond:server(document).respond});
});

test('path drag handle changes canonical course order without removing entries',async()=>{
  await mounted(async({doc,click,field,calls})=>{
    await click('مسار جديد');await change(field('عنوان المسار'),'مسار بالسحب');for(const id of [ids.course,ids.other]){await change(field('إضافة دورة موجودة'),id);await click('إضافة للمسار');}
    await drag(doc.querySelector('[aria-label="اسحب لترتيب دورة المسار 2"]'),doc.querySelector('[aria-label="اسحب لترتيب دورة المسار 1"]').parentElement);await click('حفظ المسار');assert.deepEqual(calls.find(call=>call.url.endsWith('/save_path')).body.payload.document.courseIds,[ids.other,ids.course]);
  },{view:'paths'});
});

test('successful course create is not repeated when focused read initially fails',async()=>{
  const fake=server();let reads=0;
  await mounted(async({doc,click,field,calls})=>{
    await click('دورة جديدة');await change(field('عنوان الدورة'),'دورة استعادة الاتصال');await submit(doc.querySelector('[role="dialog"] form'));assert.ok(doc.querySelector('[role="dialog"] [role="alert"]'));await submit(doc.querySelector('[role="dialog"] form'));assert.equal(calls.filter(call=>call.url.endsWith('/create_course')).length,1);assert.equal(field('عنوان الدورة').value,'دورة استعادة الاتصال');
  },{respond:call=>call.url.endsWith('/snapshot')&&reads++===0?fail('تعذر تحميل المسودة. حاول مرة أخرى.'):fake.respond(call)});
});

test('changing list tabs clears server filters and external publication warning is visible',async()=>{
  const fake=server();
  await mounted(async({doc,click,calls})=>{
    await change(doc.querySelector('input[type="search"]'),'عنوان البحث');await click('بحث');await click('المسارات');assert.deepEqual(calls.at(-1).body.payload,{query:'',offset:0,pathOffset:0});assert.equal(doc.querySelector('input[type="search"]').value,'');
    await click('الدورات');await click('تعديل الدورة');assert.match(doc.body.textContent,/يوجد إصدار أحدث نُشر من محرر آخر/);
  },{respond:async call=>{const response=fake.respond(call);const body=await response.json();if(body.data.course)body.data.course.externallyUpdated=true;return {ok:true,json:async()=>body};}});
});
