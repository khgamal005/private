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

test('real learner workspace honors the server role, uses no demo data, and reads activity content through API',async()=>{
  await mounted(learner,async({doc,button,click,calls})=>{
    assert.equal(button('إدارة التدريب'),undefined);assert.equal(button('القبول والسداد'),undefined);assert.equal(button('تصحيح الواجبات'),undefined);
    assert.equal(doc.querySelector('[aria-label="معاينة واجهة الدور"]'),null);
    assert.equal(doc.body.textContent.includes('محتوى خاص'),false);assert.equal(doc.body.textContent.includes('محمد العتيبي'),false);
    await click('الدرس الحقيقي');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/training/open_unit');
    assert.deepEqual(calls[0].body.payload,{enrollmentId:'enrollment-1',unitId:'unit-1'});assert.ok(calls[0].body.commandId);
    assert.match(doc.body.textContent,/محتوى خاص مسموح لهذا المتدرب/);
  });
});

test('uncertain API outcome retains the same command on retry and never invents progress',async()=>{
  await mounted(learner,async({doc,click,calls})=>{
    await click('الدرس الحقيقي');assert.match(doc.querySelector('[role="alert"]').textContent,/الاتصال/);
    assert.equal(doc.body.textContent.includes('محتوى خاص'),false);
    await click('الدرس الحقيقي');assert.equal(calls.length,2);assert.equal(calls[0].body.commandId,calls[1].body.commandId);
    assert.deepEqual(calls[0].body.payload,calls[1].body.payload);assert.match(doc.body.textContent,/محتوى خاص/);
    assert.equal(doc.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'0');
  },{respond:index=>{if(index===1)throw Error('تعذر الاتصال');return {ok:true,json:async()=>({data:{unit:{...unit,body:'محتوى خاص'}}})};}});
});

test('a refreshed suspended enrollment hides uncompleted opened content and meeting link',async()=>{
  await mounted(learner,async({doc,click,render,button,calls})=>{
    await click('الدرس الحقيقي');assert.ok(doc.querySelector('a[href="https://example.test/meeting"]'));
    const suspended={...enrollment,financialAccess:{...enrollment.financialAccess,trainingAllowed:false,reasonCodes:['installment_grace_expired']}};
    await render({...learner,learning:{...learner.learning,enrollments:[suspended]}});
    assert.equal(doc.body.textContent.includes('محتوى خاص'),false);assert.equal(doc.querySelector('a[href="https://example.test/meeting"]'),null);
    assert.equal(button('الدرس الحقيقي').disabled,true);assert.equal(calls.length,1);
  });
});

test('empty production data renders an actionable empty state without demonstration enrollments',async()=>{
  await mounted({...learner,learning:{...learner.learning,enrollments:[]}},async({doc,calls})=>{
    assert.match(doc.body.textContent,/رحلتك التدريبية ستبدأ هنا/);assert.equal(doc.body.textContent.includes('الدورة الحقيقية'),false);assert.equal(calls.length,0);
  });
});
