import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {JSDOM,VirtualConsole} from 'jsdom';

// Compile the actual JSX components with the project's existing TypeScript dependency.
// Only Next's router is replaced; every page read uses the mocked transport below.
const require=createRequire(import.meta.url);
const cache=new Map();
function component(relative){
  const filename=fileURLToPath(new URL(relative,import.meta.url));
  if(cache.has(filename))return cache.get(filename).exports;
  const compiledModule=new Module(filename);compiledModule.filename=filename;
  const localRequire=createRequire(filename);
  compiledModule.require=specifier=>{
    if(specifier==='next/navigation')return {useRouter:()=>({refresh(){}})};
    if(specifier.startsWith('.')&&path.resolve(path.dirname(filename),specifier).includes('/components/')){
      return component(new URL(`${specifier}.js`,new URL(relative,import.meta.url)).href);
    }
    return localRequire(specifier);
  };
  cache.set(filename,compiledModule);
  compiledModule._compile(ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{
    jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022
  }}).outputText,filename);
  return compiledModule.exports;
}

test('employee paging, filters, selection, retry and stale responses',async t=>{
  const runtimeErrors=[];
  const virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>runtimeErrors.push(error.message));
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{
    url:'https://fixture.invalid',pretendToBeVisual:true,virtualConsole});
  const original=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,
    HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,
    Node:dom.window.Node,HTMLInputElement:dom.window.HTMLInputElement,
    HTMLSelectElement:dom.window.HTMLSelectElement,
    requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true})){
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const {createElement:h,Fragment,act}=require('react');
  const {createRoot}=require('react-dom/client');
  const Workspace=component('../components/lead-intake-workspace.js').default;
  const SystemPagination=component('../components/system-data-pagination.js').default;
  const root=createRoot(document.getElementById('root'));
  const requests=[];
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>{
    assert.equal(url,'/api/tenant/lead-intake-page','the test must never call a mutation or external endpoint');
    return new Promise(resolve=>requests.push({body:JSON.parse(options.body),signal:options.signal,resolve}));
  };
  t.after(async()=>{
    await act(()=>root.unmount());globalThis.fetch=previousFetch;dom.window.close();
    for(const [key,value] of original){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}
  });
  const initialData={timezone:'Asia/Riyadh',viewer:{canDistribute:true,canReassign:true},
    rows:[],assignments:[],batches:[],staff:[],campaigns:[{source:'meta',campaignName:'حملة أغسطس'}]};
  const render=async data=>act(()=>root.render(h(Fragment,null,h(Workspace,{slug:'synthetic-test',initialData:data}),h(SystemPagination))));
  const tick=async(ms=15)=>act(()=>new Promise(resolve=>setTimeout(resolve,ms)));
  const nextRequest=async()=>{await tick(280);assert.ok(requests.length);return requests.shift()};
  const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const reply=async(req,{start=1,total=2106,count=100,name,error}={})=>{
    const section=req.body.section;
    const records=Array.from({length:count},(_,i)=>({id:id(start+i),batchId:id(9999),
      name:name||`عميل ${start+i}`,contactName:name||`عميل ${start+i}`,
      fileName:`دفعة ${start+i}`,batchFileName:'دفعة أغسطس',source:'meta',campaignName:'حملة أغسطس',
      validationStatus:'valid',queueStatus:'awaiting_distribution',validationErrors:[],status:'active',
      totalRows:10,validRows:10,awaitingRows:10,distributedRows:0,duplicateRows:0,invalidRows:0,
      phone:'0500000000',assignedStaffName:'موظف تجريبي',leadStatus:'new',strategy:'fair'}));
    const hasMore=start+count-1<total;
    await act(async()=>{req.resolve({ok:!error,json:async()=>error?{error}:{data:{
      schemaVersion:'lead-intake-page-v1',section,limit:100,anchor:req.body.anchor||'2026-09-06T00:00:00Z',
      total:req.body.cursor?null:total,records,hasMore,
      nextCursor:hasMore?{id:records.at(-1).id,at:'2026-08-01T00:00:00Z'}:null
    }}})});
    await tick(25);
  };
  const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent===label);
  const click=async element=>{assert.ok(element);assert.equal(element.disabled,false);await act(()=>element.click())};
  const fill=async(input,value)=>act(()=>{
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  });
  const statuses=()=>[...document.querySelectorAll('[role="status"]')].map(x=>x.textContent);
  const selected=()=>document.querySelectorAll('tbody input:checked').length;

  await render(initialData);await reply(await nextRequest(),{total:3213});
  assert.equal(document.querySelectorAll('tbody tr').length,100);
  assert.equal(document.querySelectorAll('tbody tr[hidden]').length,0);
  assert.equal(document.querySelectorAll('.mt-data-pagination').length,2,'only server controls above and below');
  assert.ok(statuses().every(s=>s.includes('٣٬٢١٣')));
  await click(document.querySelector('thead input'));assert.equal(selected(),100);
  await click(button('التالي'));assert.equal(selected(),0);
  await reply(await nextRequest(),{start:101,total:3213});
  await click(document.querySelector('thead input'));assert.equal(selected(),100);
  await click(button('التالي'));await reply(await nextRequest(),{start:201,total:3213});
  await click(button('السابق'));await reply(await nextRequest(),{start:101,total:3213});
  assert.equal(selected(),0,'returning to a visited page must not restore a bulk selection');

  await click(button('سجل التوزيع'));await reply(await nextRequest());
  await fill(document.querySelector('input[type="date"]'),'2026-08-01');
  let req=await nextRequest();assert.equal(req.body.from,'2026-08-01');assert.equal(req.body.cursor,null);
  await reply(req);
  await click(document.querySelector('thead input'));assert.equal(selected(),100);
  await click(button('التالي'));await reply(await nextRequest(),{start:101});assert.equal(selected(),0);
  await fill(document.querySelectorAll('input[type="date"]')[1],'2026-08-31');
  req=await nextRequest();assert.equal(req.body.to,'2026-08-31');assert.equal(req.body.cursor,null);
  await reply(req);assert.ok(statuses()[0].includes('٢٬١٠٦'));

  const search=document.querySelector('input[placeholder="ابحث مباشرة باسم العميل أو رقم الهاتف..."]');
  await fill(search,'بطيء');const slow=await nextRequest();
  await fill(search,'سريع');const fast=await nextRequest();assert.equal(slow.signal.aborted,true);
  await reply(fast,{name:'النتيجة الأحدث',total:1,count:1});
  await reply(slow,{name:'نتيجة متأخرة'});
  assert.ok(document.querySelector('tbody').textContent.includes('النتيجة الأحدث'));
  assert.ok(!document.querySelector('tbody').textContent.includes('نتيجة متأخرة'));
  await fill(search,'خطأ');await reply(await nextRequest(),{error:'تعذر تحميل السجل'});
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(document.querySelectorAll('tbody tr').length,0);
  assert.equal(button('التالي').disabled,true);
  await click(button('إعادة المحاولة'));await reply(await nextRequest(),{total:1,count:1});
  assert.equal(document.querySelector('[role="alert"]'),null);
  await click(document.querySelector('thead input'));assert.equal(selected(),1);
  await render({...initialData});await reply(await nextRequest(),{total:1,count:1});
  assert.equal(selected(),0,'refresh after a mutation resets selection and reloads the first page');

  await click(button('دفعات الرفع'));await reply(await nextRequest(),{total:120});
  await click(button('التالي'));await reply(await nextRequest(),{start:101,total:120,count:20});
  await click(button('عرض صفوف الدفعة'));req=await nextRequest();
  assert.equal(req.body.section,'queue');assert.equal(req.body.batchId,id(101));assert.equal(req.body.cursor,null);
  await reply(req,{total:1,count:1});
  assert.ok([...document.querySelectorAll('option')].some(x=>x.value===id(101)));
  assert.deepEqual(runtimeErrors,[],'the actual global paginator must remain compatible');
});
