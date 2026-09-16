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

const require=createRequire(import.meta.url);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const modules=new Map();
const navigation=[];
const router={push:(url)=>navigation.push(url),refresh(){}};
function load(path){
  const file=resolve(root,path);
  if(modules.has(file))return modules.get(file).exports;
  const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
  const componentModule={exports:{}};modules.set(file,componentModule);
  const localRequire=name=>{
    if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
    if(name==='next/navigation')return {useRouter:()=>router};
    if(name.startsWith('.')){
      const target=resolve(dirname(file),name);
      const found=[target,...['.tsx','.ts','.js','.mjs'].map(extension=>target+extension)].find(existsSync);
      assert.ok(found,`local dependency ${name}`);return load(found);
    }
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:file})(localRequire,componentModule,componentModule.exports);
  return componentModule.exports;
}

const tenantId='3d185482-b916-49cc-b868-b6dfdb93eba8';
const subjectId='1a795753-f2a7-44ed-a0db-7f85b1f6fbef';
const props={slug:'marktone',tenantId,subjectId,initialView:'dashboard',canPreviewRoles:true};
const storageKey=(tenant=tenantId,subject=subjectId)=>'odeir:interactive-training:demo:v2:'+encodeURIComponent(tenant)+':'+encodeURIComponent(subject);

async function mounted(initialProps,fn,{seed={},sessionSeed={}}={}){
  const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://odeir.com/tenant/marktone/lms'});
  const previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  dom.window.scrollTo=()=>{};
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  for(const [key,value] of Object.entries(seed))dom.window.localStorage.setItem(key,JSON.stringify(value));
  for(const [key,value] of Object.entries(sessionSeed))dom.window.sessionStorage.setItem(key,value);
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(...args)=>{calls.push(args);throw new Error('The preview must not write to the backend');};
  const {createRoot}=await import('react-dom/client');
  const app=createRoot(document.getElementById('app'));
  const Component=load('components/interactive-training-workspace.tsx').default;
  let currentProps={...initialProps};
  const render=async patch=>{currentProps={...currentProps,...patch};await act(async()=>app.render(React.createElement(Component,currentProps)));};
  const button=(text,scope=document)=>[...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
  const click=async(text,scope=document)=>{const node=button(text,scope);assert.ok(node,`button ${text}`);assert.equal(node.disabled,false,`enabled button ${text}`);await act(async()=>node.click());};
  const input=async(node,value)=>{
    assert.ok(node,'input exists');
    const prototype=node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;
    await act(async()=>{Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  };
  try{await render({});await fn({doc:document,dom,click,button,input,render,calls,stored:()=>JSON.parse(localStorage.getItem(storageKey(currentProps.tenantId,currentProps.subjectId))||'null')});assert.equal(calls.length,0,'all interactions remain local');}
  finally{await act(async()=>app.unmount());dom.window.close();globalThis.fetch=originalFetch;for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
}

test('a learner completes lessons and assessment, submits work, receives an instructor grade, then previews the certificate',async()=>{
  await mounted(props,async({doc,click,button,input,render,stored})=>{
    await click('المتدرب');
    const courseRow=[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('تحليل البيانات باستخدام Power BI'));
    await click('متابعة',courseRow);
    assert.equal(button('معاينة شهادة الإكمال').disabled,true);
    assert.equal(doc.querySelectorAll('.lesson-list button')[1].disabled,true,'later lessons are initially locked');
    for(let index=0;index<4;index++)await click('أكملت الدرس');
    assert.deepEqual(stored().completed.data,[0,1,2,3]);
    assert.equal(button('معاينة شهادة الإكمال').disabled,true,'lesson completion alone does not issue a certificate');
    await act(async()=>doc.querySelectorAll('.quiz-option')[0].click());
    await click('تحقق من الإجابة');
    assert.match(doc.body.textContent,/جرّب مرة أخرى/);
    assert.equal(Boolean(stored().quizPassed.data),false);
    await act(async()=>doc.querySelectorAll('.quiz-option')[1].click());
    await click('تحقق من الإجابة');
    assert.equal(stored().quizPassed.data,true);
    await input(doc.querySelector('textarea[placeholder="اكتب تطبيقك في ٢٠ حرفًا على الأقل…"]'),'أحدد هدف رفع الإكمال ثم أراجع بيانات التسجيل وأحسب النسبة بمصدر واضح وفترة محددة.');
    await click('تسليم النشاط');
    assert.equal(stored().grades.data,-1);
    assert.equal(button('معاينة شهادة الإكمال').disabled,true,'an ungraded submission cannot unlock the certificate');
    await click('المحاضر');
    await render({initialView:'assessments'});
    assert.match(doc.body.textContent,/أحدد هدف رفع الإكمال/);
    await click('مراجعة وتصحيح');
    await input(doc.querySelector('input[type="number"]'),'69');
    await click('حفظ التقييم');
    assert.equal(stored().grades.data,69);
    await click('المتدرب');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    assert.equal(button('معاينة شهادة الإكمال').disabled,true,'a grade below the pass threshold stays incomplete');
    await click('المحاضر');
    await render({initialView:'dashboard'});
    await render({initialView:'assessments'});
    await click('مراجعة وتصحيح');
    await input(doc.querySelector('input[type="number"]'),'85');
    await click('حفظ التقييم');
    await click('المتدرب');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    await click('معاينة شهادة الإكمال');
    assert.match(doc.body.textContent,/شهادة إكمال تجريبية/);
    assert.match(doc.body.textContent,/محمد العتيبي/);
    assert.match(doc.body.textContent,/قالب للمعاينة/);
    assert.equal(stored().grades.data,85);
  });
});

test('browser progress is isolated by tenant and authenticated subject, including same-component identity changes',async()=>{
  await mounted(props,async({doc,click,render,stored,dom})=>{
    await click('المتدرب');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    await click('أكملت الدرس');
    assert.deepEqual(stored().completed.data,[0]);
    const otherSubject='21c8c6fb-c45b-48b1-8e1e-ad2504e8c6a2';
    await render({subjectId:otherSubject});
    assert.equal(stored(),null,'new authenticated user has no saved progress');
    assert.match(doc.body.textContent,/كل رحلة تعلّم تبدأ من هنا/,'role preview did not leak between users');
    await click('المتدرب');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    assert.equal(doc.querySelectorAll('.lesson-list button')[1].disabled,true);
    const otherTenant='ca4d407c-b088-4231-afd6-8ea7795c492c';
    await render({tenantId:otherTenant,subjectId});
    assert.equal(stored(),null,'the same user has no progress under a different tenant');
    await render({tenantId,subjectId});
    assert.deepEqual(stored().completed.data,[0]);
    assert.equal(dom.window.localStorage.length,1,'identity switches do not copy the old state into new keys');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    assert.equal(doc.querySelectorAll('.lesson-list button')[1].disabled,false,'returning to the original identity restores its own progress');
  });
});

test('readiness renders evidence status without the removed warning or an accreditation claim',async()=>{
  await mounted({...props,initialView:'compliance'},async({doc})=>{
    const text=doc.body.textContent;
    assert.equal(doc.querySelectorAll('.compliance-card').length,12);
    assert.doesNotMatch(text,/النموذج ليس منصة معتمدة بعد/);
    assert.doesNotMatch(text,/هذه محاور عمل منتقاة من المتطلبات الرسمية/);
    assert.doesNotMatch(text,/ليست مراجعة امتثال مكتملة/);
    assert.doesNotMatch(text,/المنصة معتمدة من المركز الوطني|منصة معتمدة لدى المركز|معتمدة رسميًا/);
    assert.match(text,/بانتظار الدليل/);
    assert.match(text,/FutureX: قيد التجهيز/);
  });
});

test('role preview controls honor the server capability and route changes select the matching native screen',async()=>{
  await mounted({...props,canPreviewRoles:false},async({doc,render})=>{
    assert.equal(doc.querySelector('[aria-label="معاينة واجهة الدور"]'),null);
    assert.match(doc.body.textContent,/أهلًا د. أحمد/,'a stored manager preview cannot replace the server role capability');
    for(const [initialView,title] of [['courses','دوراتي'],['paths','المسارات التعليمية'],['categories','تصنيفات الدورات'],['support','الدعم والسياسات']]){
      await render({initialView});assert.match(doc.querySelector('h1').textContent,new RegExp(title));
    }
    for(const initialView of ['settings','compliance','waitlist']){
      await render({initialView});assert.match(doc.body.textContent,/هذه الشاشة ضمن مساحة المدير/);assert.equal(doc.querySelector('input,textarea'),null);
    }
  },{sessionSeed:{[storageKey()+':role']:'admin'}});
});

test('revoking role-preview capability for the same identity clears the open student view and manager controls',async()=>{
  await mounted(props,async({doc,click,button,render})=>{
    await click('المتدرب');
    await click('متابعة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    assert.ok(button('أكملت الدرس'));
    await render({canPreviewRoles:false});
    assert.equal(doc.querySelector('[aria-label="معاينة واجهة الدور"]'),null);
    assert.equal(button('أكملت الدرس'),undefined,'the previous learner mutation screen is removed');
    assert.match(doc.body.textContent,/أهلًا د. أحمد/);
    await click('عرض الدورة',[...doc.querySelectorAll('.course-row')].find(node=>node.textContent.includes('Power BI')));
    assert.equal(button('تجربة المتدرب').disabled,true);
    assert.equal(button('معاينة').disabled,true);
    await render({initialView:'settings'});
    assert.match(doc.body.textContent,/هذه الشاشة ضمن مساحة المدير/);
    assert.equal(button('إعادة ضبط النموذج'),undefined);
    await render({initialView:'assessments'});
    assert.equal(button('افتح نشاطًا للتجربة').disabled,true);
  });
});

test('the AI authoring prototype requires human review and saves a draft that students cannot access',async()=>{
  await mounted(props,async({doc,click,button,input,stored})=>{
    await click('إنشاء دورة');
    assert.ok(doc.querySelector('dialog[open]'));
    assert.match(doc.querySelector('dialog').textContent,/محاكاة التأليف الذكي/);
    const title='دورة اختبار تأليف داخل ماركتون';
    await input(doc.querySelector('dialog input'),title);
    await click('إنشاء هيكل تجريبي');
    assert.equal(button('حفظ مسودة الدورة').disabled,true);
    await act(async()=>doc.querySelector('dialog input[type="checkbox"]').click());
    await click('حفظ مسودة الدورة');
    const state=stored(),draft=state.courses.find(course=>course.title===title);
    assert.equal(draft.status,'مسودة');
    assert.equal(draft.reviewed,true);
    assert.equal(state.aiAudit.length,1);
    assert.equal(state.aiAudit[0].title,title);
    assert.equal(doc.querySelector('dialog'),null);
    await click('المتدرب');
    assert.equal([...doc.querySelectorAll('.course-row h3')].some(node=>node.textContent===title),false,'human review does not automatically publish the draft');
    assert.equal(button('إنشاء دورة'),undefined);
  });
});
