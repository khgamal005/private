import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React,{act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {validateExpertApplication,publicationReasons} from '../lib/service-hub.mjs';
import {application} from './fixtures/service-hub-db.mjs';
const require=createRequire(import.meta.url),root=resolve(dirname(new URL(import.meta.url).pathname),'..'),modules=new Map();
const router={refresh(){}};
let sessionToken='fixture-user-token';
function load(path){
  const file=resolve(root,path);if(modules.has(file))return modules.get(file).exports;
  const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const componentModule={exports:{}};modules.set(file,componentModule);
  const localRequire=name=>{
    if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
    if(name==='next/navigation')return {useRouter:()=>router};
    if(name==='next/headers')return {cookies:async()=>({get:()=>sessionToken?{value:sessionToken}:undefined})};
    if(name==='next/server')return {NextResponse:{json:(value,options)=>new Response(JSON.stringify(value),options)}};
    if(name==='next/link')return {__esModule:true,default:props=>React.createElement('a',props)};
    if(name==='next/image')return {__esModule:true,default:props=>React.createElement('img',props)};
    if(name.startsWith('.'))return load(resolve(dirname(file),name+( /\.(mjs|js|tsx)$/.test(name)?'':'.js')));
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:file})(localRequire,componentModule,componentModule.exports);return componentModule.exports;
}
const expert={id:'provider',name:'محاضر اختبار',title:'إدارة المشروعات',shortBio:'تقديم البرامج التدريبية',status:'active',expertise:['إدارة المشروعات'],availabilityStatus:'available',courses:[]};
const service={id:'product',key:'workshop',name:'ورشة إدارة المشروعات',description:'مخرجات تدريبية واضحة لمنشأة الاختبار',categoryId:'category',categoryName:'التدريب',provider:expert,providerId:expert.id,pricingMode:'quote',amountMinor:0,status:'active',marketplaceVisible:true,packages:[]};
const hub={enabled:true,experts:[expert],expertCount:1,requests:[],requestCount:0,applications:[],applicationCount:0,reviews:[],publications:[{providerId:expert.id,published:true}]};
const methods=[{key:'bank_transfer',name:'تحويل بنكي'},{key:'paymob',name:'الدفع الإلكتروني'}];
const store={viewer:{canPurchase:true},services:[service],orders:[],paymentMethods:methods,categories:[{id:'category',key:'training',name:'التدريب'}],hub};

async function mounted(component,props,fn){
  const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://odeir.com/tenant/hub-fixture/services-store'});
  const previous=new Map();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  const {createRoot}=await import('react-dom/client');const app=createRoot(document.getElementById('app'));
  const click=async text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(button,`button ${text}`);await act(async()=>button.click());};
  try{await act(async()=>app.render(React.createElement(component,props)));await fn({doc:document,click,dom});}
  finally{await act(async()=>app.unmount());dom.window.close();for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
}

test('application validation rejects missing experience, private URL credentials and unbounded lists',()=>{
  assert.equal(validateExpertApplication(application).email,application.email);
  for(const data of [{yearsExperience:''},{portfolioUrl:'https://user:pass@example.test'},{consent:false},{languages:Array(21).fill('العربية').join(',')}])assert.throws(()=>validateExpertApplication({...application,...data}));
});

test('both complete services screens render without scope errors, with a working quote CTA and registration queue',()=>{
  const Marketplace=load('components/marketplace-store.js').default,Platform=load('components/platform-services.js').default;
  const html=renderToStaticMarkup(React.createElement(Marketplace,{slug:'hub-fixture',initialData:store}));const doc=new JSDOM(html).window.document;
  assert.equal([...doc.querySelectorAll('button')].find(b=>b.textContent==='طلب عرض سعر').disabled,false);
  assert.match(html,/المحاضرون والخبراء/);assert.match(html,/طلباتي/);
  const blocked=new JSDOM(renderToStaticMarkup(React.createElement(Marketplace,{slug:'hub-fixture',initialData:{...store,viewer:{canPurchase:false}}}))).window.document;
  const blockedQuote=[...blocked.querySelectorAll('button')].find(b=>b.textContent==='طلب عرض سعر');assert.equal(blockedQuote.disabled,true);assert.match(blockedQuote.dataset.blockReason,/صلاحية/);
  const Publication=load('components/platform-service-hub.js').ProviderPublication;
  const draft=new JSDOM(renderToStaticMarkup(React.createElement(Publication,{provider:{...expert,status:'draft'},hub:{...hub,publications:[]}}))).window.document;
  assert.equal(draft.querySelector('button').disabled,true);assert.match(draft.querySelector('button').dataset.blockReason,/فعّل حالة المحاضر/);
  const admin=renderToStaticMarkup(React.createElement(Platform,{initialData:{services:[service],providers:[expert],serviceCategories:[{id:'category',status:'active',name:'تدريب'}],hub}}));assert.match(admin,/طلبات الانضمام/);assert.match(admin,/معاينة/);
  assert.deepEqual(publicationReasons(service,[{id:'category',status:'active'}],[expert]),[]);
  assert.deepEqual(publicationReasons({...service,status:'draft'},[{id:'category',status:'active'}],[expert]),['الخدمة ليست نشطة']);
});

test('tenant can discover a zero-service expert and send one retry-safe request from their profile',async()=>{
  const Marketplace=load('components/marketplace-store.js').default;const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({data:{id:'new-request'}})};};
  try{await mounted(Marketplace,{slug:'hub-fixture',initialData:{...store,services:[]}},async({doc,click,dom})=>{
    await click('المحاضرون والخبراء');assert.match(doc.body.textContent,/محاضر اختبار/);await click('عرض الملف');assert.ok(doc.querySelector('dialog[open]'));await click('طلب هذا الخبير');
    const form=doc.querySelector('dialog form');form.elements.details.value='ورشة تدريب عملية لفريق المنشأة خلال الشهر القادم';
    await act(async()=>{form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
    assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/tenant/service-hub');assert.equal(calls[0].body.slug,'hub-fixture');assert.equal(calls[0].body.payload.providerId,expert.id);assert.match(calls[0].body.payload.requestKey,/^[0-9a-f-]{36}$/);assert.match(doc.body.textContent,/تم إرسال طلبك/);
  });}finally{globalThis.fetch=original;}
});

test('public application sends explicit consent once and preserves form values after an error',async()=>{
  const Application=load('components/expert-application.js').default;const original=globalThis.fetch;let attempts=0;
  globalThis.fetch=async(_url,options)=>{attempts++;const body=JSON.parse(options.body);assert.equal(body.consent,true);assert.equal(body.email,application.email);return {ok:attempts>1,json:async()=>attempts===1?{error:'خطأ اتصال اختباري'}:{success:true}};};
  try{await mounted(Application,{},async({doc,dom})=>{
    const form=doc.querySelector('form');for(const [name,value] of Object.entries(application)){const input=form.elements.namedItem(name);if(input){if(name==='consent')input.checked=true;else input.value=String(value);}}
    const submit=()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await act(async()=>submit());assert.match(doc.body.textContent,/خطأ اتصال اختباري/);assert.equal(form.elements.name.value,application.name);
    await act(async()=>{submit();submit();});assert.equal(attempts,2);assert.match(doc.body.textContent,/تم استلام طلبك/);assert.equal(doc.querySelector('form'),null);
  });}finally{globalThis.fetch=original;}
});

test('accepting an offer sends its version and chosen payment method, with no payment initialization',async()=>{
  const {RequestsPanel}=load('components/service-hub-ui.js');const original=globalThis.fetch;const calls=[];let accepted;
  const request={id:'quote',version:4,status:'offered',brief:{title:'عرض تدريب',details:'تفاصيل متطلبات برنامج المنشأة',deliveryMode:'online'},offer:{title:'ورشة',scope:'مادة تدريبية وتمارين عملية',amountMinor:10000,taxMinor:1500,totalMinor:11500},expiresAt:'2099-01-01T00:00:00Z'};
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return {ok:true,json:async()=>({data:body.action==='snapshot'?{...hub,requests:[{...request,status:'accepted'}]}:{id:'canonical-order'}})};};
  try{await mounted(RequestsPanel,{slug:'hub-fixture',hub:{...hub,requests:[request]},paymentMethods:methods,onAccepted:order=>{accepted=order;}},async({doc,click})=>{
    await click('عرض التفاصيل والموافقة');const approve=[...doc.querySelectorAll('button')].find(b=>b.textContent==='اعتماد العرض وإنشاء طلب الدفع');assert.equal(approve.disabled,true);await act(async()=>doc.querySelector('input[type=checkbox]').click());await click('اعتماد العرض وإنشاء طلب الدفع');
    assert.equal(accepted.id,'canonical-order');assert.deepEqual(calls[0].body.payload,{id:'quote',version:4,paymentProvider:'bank_transfer'});assert.ok(calls.every(c=>c.url==='/api/tenant/service-hub'));
  });}finally{globalThis.fetch=original;}
});

test('application API rejects cross-origin, oversized and malformed bodies and sends no user token to its anonymous RPC',async()=>{
  const {POST}=load('app/api/experts/apply/route.js');const original=globalThis.fetch;const calls=[];
  const request=(body,origin='https://odeir.com',type='application/json')=>new Request('https://odeir.com/api/experts/apply',{method:'POST',headers:{origin,host:'odeir.com','content-type':type},body});
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({received:true})};};
  try{
    assert.equal((await POST(request(JSON.stringify(application),'https://evil.test'))).status,403);
    assert.equal((await POST(request('x','https://odeir.com','text/plain'))).status,415);
    assert.equal((await POST(request('{broken'))).status,400);
    assert.equal((await POST(request(JSON.stringify({bio:'س'.repeat(15000)})))).status,413);
    assert.equal(calls.length,0);
    const response=await POST(request(JSON.stringify(application)));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);
    assert.match(calls[0].url,/v1_public_expert_application$/);
    sessionToken='';const tenant=load('app/api/tenant/service-hub/route.js');const unauthorized=await tenant.POST(request(JSON.stringify({slug:'hub-fixture',action:'snapshot'})));assert.equal(unauthorized.status,401);assert.equal(calls.length,1);
  }finally{globalThis.fetch=original;sessionToken='fixture-user-token';}
});

test('service setup keeps all form values across its three steps and offers only supported states',async()=>{
  const {ServiceSetup}=load('components/platform-service-hub.js');let saved;
  await mounted(ServiceSetup,{item:service,providers:[expert],courses:[],categories:[{id:'category',name:'التدريب',status:'active'}],onClose(){},onSubmit:event=>{saved=Object.fromEntries(new FormData(event.currentTarget));}},async({doc,click,dom})=>{
    await click('التالي');assert.equal(doc.querySelector('[data-step="1"]').hidden,false);await click('التالي');assert.equal(doc.querySelector('[data-step="2"]').hidden,false);
    assert.deepEqual([...doc.querySelector('select[name=status]').options].map(o=>o.value),['draft','active','beta','archived']);
    await click('معاينة ومراجعة الظهور');assert.match(doc.body.textContent,/جاهزة للظهور/);
    const form=doc.querySelector('form');await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(saved.name,service.name);assert.equal(saved.provider_id,expert.id);assert.equal(saved.category_id,'category');assert.equal(saved.pricing_mode,'quote');
  });
});

test('admin approval reviews the application without publishing, and an offer sends fixed minor units with its expected version',async()=>{
  const Panel=load('components/platform-service-hub.js').default;const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return {ok:true,json:async()=>({data:body.action==='snapshot'?hub:{providerId:'draft-expert',id:'quote'}})};};
  try{
    await mounted(Panel,{mode:'applications',hub:{...hub,applications:[{id:'application',payload:application,status:'pending'}]},providers:[],services:[],onEditProvider(){}},async({doc,click,dom})=>{
      await click('مراجعة الطلب');const form=doc.querySelector('dialog form');await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls[0].body.action,'approve_application');assert.equal(calls[0].body.payload.id,'application');assert.equal(calls.some(c=>c.body.action==='publish_provider'),false);
    });
    const request={id:'quote',version:3,status:'requested',tenantName:'Fixture',brief:{title:'برنامج تدريب',details:'احتياج منشأة اختبارية إلى برنامج تدريبي',deliveryMode:'online'}};
    await mounted(Panel,{mode:'quotes',hub:{...hub,requests:[request]},providers:[expert],services:[service],onEditProvider(){}},async({doc,click,dom})=>{
      await click('تفاصيل الطلب وإعداد العرض');const form=doc.querySelector('dialog form');for(const [key,value] of Object.entries({productId:'product',providerId:'provider',scope:'تنفيذ ورشة تدريبية وتقديم المواد العلمية',delivery:'خلال خمسة أيام',amount:'2500.25',expiresAt:'2099-01-01T12:00'}))form.elements[key].value=value;
      await act(async()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));const offer=calls.find(c=>c.body.action==='offer');assert.equal(offer.url,'/api/platform/service-hub');assert.equal(offer.body.payload.amountMinor,250025);assert.equal(offer.body.payload.version,3);assert.equal(offer.body.payload.productId,'product');
    });
  }finally{globalThis.fetch=original;}
});
