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
import {courseId,runId,secondRunId,teacherId,deliveryView,peopleView,storeView} from './fixtures/academy-delivery-ui.mjs';
const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),modules=new Map();
let uploadOptions,uploadClient;
function load(path){
 const file=resolve(root,path);if(modules.has(file))return modules.get(file).exports;
 const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
 const componentModule={exports:{}};modules.set(file,componentModule);
 vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:file})(name=>{
  if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
  if(name==='next/link')return {__esModule:true,default:props=>React.createElement('a',props)};
  if(name==='next/navigation')return {useRouter:()=>({refresh(){}})};
  if(name.endsWith('academy-media-upload.mjs'))return {startAcademyVideoUpload:async options=>{uploadOptions=options;return uploadClient;}};
  if(name.startsWith('.')){const target=resolve(dirname(file),name);return load([target,...['.tsx','.ts','.js','.mjs'].map(ext=>target+ext)].find(existsSync));}
  return require(name);
 },componentModule,componentModule.exports);return componentModule.exports;
}
async function mounted(component,props,respond,run){
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://odeir.com/academy/marktone'}),prior=new Map();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,FormData:dom.window.FormData,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
  prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 }
 const originalFetch=globalThis.fetch,calls=[];globalThis.fetch=async(url,options={})=>{const call={url,body:options.body?JSON.parse(options.body):null};calls.push(call);return respond(call);};
 const {createRoot}=await import('react-dom/client'),app=createRoot(document.getElementById('app')),Component=load(`components/${component}.js`).default;
 const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent.includes(text));
 const click=async text=>{const node=button(text);assert.ok(node,text);assert.equal(node.disabled,false,text);await act(async()=>node.click());};
 const field=text=>[...document.querySelectorAll('label')].find(node=>node.querySelector('span')?.textContent===text)?.querySelector('input,select,textarea');
 try {await act(async()=>app.render(React.createElement(Component,props)));await run({doc:document,calls,button,click,field});}
 finally {await act(async()=>app.unmount());dom.window.close();globalThis.fetch=originalFetch;for(const [key,value] of prior){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
}
const ok=value=>({ok:true,json:async()=>structuredClone(value)}),bad=error=>({ok:false,json:async()=>({error})});
async function change(node,value){assert.ok(node);await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));node.dispatchEvent(new window.Event('change',{bubbles:true}));});}
const submit=async form=>act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));

test('course selling saves canonical price, separates publication and retries an interrupted request',async()=>{
 const data=deliveryView();let attempts=0;
 await mounted('academy-course-delivery',{slug:'marktone',courseId,learningMode:'live'},call=>{
  if(call.url.endsWith('/snapshot'))return ok(data);
  if(call.url.endsWith('/save_offer')){if(attempts++===0)return bad('انقطع الاتصال');Object.assign(data.offers[0],{...call.body.payload,version:2});return ok({runId});}
  if(call.url.endsWith('/publish_offer')){data.offers[0].published=true;data.offers[0].version++;return ok({});}assert.fail(call.url);
 },async({doc,calls,click,field})=>{
  assert.match(doc.body.textContent,/المحتوى: منشور/);assert.match(doc.body.textContent,/المتجر: غير ظاهر/);
  await change(field('نوع التسجيل'),'free');await submit(field('نوع التسجيل').closest('form'));assert.match(doc.querySelector('[role="alert"]').textContent,/انقطع/);
  await submit(field('نوع التسجيل').closest('form'));const saves=calls.filter(call=>call.url.endsWith('/save_offer'));assert.equal(saves[0].body.commandId,saves[1].body.commandId);assert.equal(saves[1].body.payload.netMinor,0);assert.equal(saves[1].body.payload.courseId,courseId);
  await click('إظهار في المتجر');assert.match(doc.body.textContent,/المتجر: ظاهر/);
 });
});

test('cohort selection changes sessions and instructor assignment targets exactly that cohort',async()=>{
 const data=deliveryView();
 await mounted('academy-course-delivery',{slug:'marktone',courseId,learningMode:'live'},call=>ok(call.url.endsWith('/snapshot')?data:{}),async({doc,calls,field})=>{
  assert.equal(doc.querySelector('a[href="https://zoom.us/j/123456789"]').rel,'noopener noreferrer');
  await change(field('الدفعة من التسجيل والقبول'),secondRunId);assert.equal(doc.querySelector('a[href="https://zoom.us/j/123456789"]'),null);
  await change(field('إضافة محاضر للدفعة'),teacherId);await submit(field('إضافة محاضر للدفعة').closest('form'));
  const assignment=calls.find(call=>call.url.endsWith('/assign_instructor'));assert.equal(assignment.body.payload.runId,secondRunId);assert.equal(assignment.body.payload.subjectId,teacherId);
 });
});

test('course editor opens the canonical managed Zoom session without accepting another tenant route',async()=>{
 const data=deliveryView(),sessionId='77777777-7777-4777-8777-777777777777',path=`/training/marktone/sessions/${sessionId}`;
 data.runs[0].sessions=[{id:sessionId,title:'لقاء زوم المدار',status:'scheduled',joinUrl:path},{id:teacherId,title:'رابط منشأة أخرى',status:'scheduled',joinUrl:`/training/other/sessions/${teacherId}`}];
 await mounted('academy-course-delivery',{slug:'marktone',courseId,learningMode:'live'},()=>ok(data),async({doc})=>{
  assert.equal(doc.querySelector(`a[href="${path}"]`).textContent,'فتح اللقاء ↗');
  assert.equal(doc.querySelector('a[href^="/training/other/"]'),null);
 });
});

test('store displays a course once and changes free/paid checkout when the learner selects another cohort',async()=>{
 await mounted('academy-storefront',{slug:'marktone',data:storeView()},()=>ok({}),async({doc,click,field})=>{
  assert.equal(doc.querySelectorAll('article').length,1);await change(field('اختر موعد الدورة'),'66666666-6666-4666-8666-666666666666');await click('سجّل الآن');
  assert.match(doc.body.textContent,/دورة مجانية/);assert.ok(!doc.body.textContent.includes('وسيلة السداد: التحويل البنكي'));
  assert.ok([...doc.querySelectorAll('button')].some(node=>node.textContent==='طلب التسجيل المجاني'));
 });
});

test('people tab reuses a staff profile and retains a usable invite link',async()=>{
 await mounted('academy-people-workspace',{slug:'marktone',initialData:peopleView(),canOpenOperations:true},call=>ok(call.url.endsWith('/snapshot')?peopleView(call.body.payload.kind):{invitationUrl:'/academy/accept?tenant=marktone#synthetic'}),async({doc,click,field,calls})=>{
  await click('المحاضرون');assert.match(doc.body.textContent,/3 دفعات مسندة/);await click('+ إضافة محاضر');await change(field('الربط بفريق أودير'),teacherId);
  assert.equal(field('البريد الإلكتروني').value,'teacher@example.test');await submit(field('الربط بفريق أودير').closest('form'));
  const invite=calls.find(call=>call.url.endsWith('/invite_instructor'));assert.equal(invite.body.payload.staffId,teacherId);assert.match(invite.body.payload.invitationToken,/^[a-f0-9]{64}$/);
  assert.match(field('رابط الدعوة').value,/\/academy\/accept\?tenant=marktone#synthetic$/);
 });
});

test('video upload pauses, resumes and retries finalization without publishing incomplete content',async()=>{
 const assetId=teacherId,playbackUrl=`https://odeir.com/api/academy-media/${assetId}?tenantSlug=marktone`;let changed='',starts=0,aborts=0,finishes=0;
 uploadClient={start(){starts++;},async abort(){aborts++;}};
 await mounted('academy-video-field',{slug:'marktone',courseId,value:'',onChange:value=>changed=value,enabled:true},call=>{
  if(call.url.endsWith('/create_upload'))return ok({assetId,state:'pending',objectPath:'tenant/course/video.mp4'});
  if(call.url.endsWith('/complete_upload')){finishes++;return finishes===1?{ok:false,json:async()=>({code:'academy_media_not_ready'})}:ok({assetId,state:'ready',playbackUrl,allowDownload:false,policyVersion:1});}
  assert.fail(call.url);
 },async({doc,click,calls})=>{
  await click('رفع فيديو');const input=doc.querySelector('input[type=file]');Object.defineProperty(input,'files',{value:[new window.File(['data'],'lesson.mp4',{type:'video/mp4',lastModified:1})]});
  await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));assert.equal(starts,1);assert.equal(changed,'');assert.equal(uploadOptions.autoStart,false);
  await click('إيقاف مؤقت');assert.equal(aborts,1);await click('استكمال الرفع');assert.equal(starts,2);
  await act(async()=>{uploadOptions.onProgress(100);await uploadOptions.onSuccess();});assert.equal(changed,'');assert.match(doc.body.textContent,/اكتمل الرفع، وبقي التحقق/);
  await click('إعادة التحقق');assert.equal(changed,playbackUrl);assert.equal(finishes,2);assert.equal(calls.filter(call=>call.url.endsWith('/create_upload')).length,1);assert.equal(sessionStorage.length,0);
 });
});


test('new cohort uses tenant wall time and keeps its command after a failed refresh',async()=>{
 const data=deliveryView();let created=false,refreshes=0;
 await mounted('academy-course-delivery',{slug:'marktone',courseId,learningMode:'live'},call=>{
  if(call.url.endsWith('/create_run')){created=true;return ok({runId:secondRunId});}
  if(created&&refreshes++===0)return bad('تعذر تحديث القائمة');return ok(data);
 },async({doc,calls,field})=>{
  await change(field('اسم الدفعة'),'دفعة جديدة');await change(field('بداية الدفعة'),'2030-10-01T19:00');await change(field('نهاية الدفعة'),'2030-10-01T21:00');
  const form=field('اسم الدفعة').closest('form');await submit(form);assert.match(doc.querySelector('[role="alert"]').textContent,/تعذر تحديث/);await submit(form);
  const writes=calls.filter(call=>call.url.endsWith('/create_run'));assert.equal(writes.length,2);assert.equal(writes[0].body.commandId,writes[1].body.commandId);assert.equal(writes[0].body.payload.startsAt,'2030-10-01T16:00:00.000Z');
 });
});
