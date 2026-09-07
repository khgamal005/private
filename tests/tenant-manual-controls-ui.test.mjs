import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createRequire,Module} from 'node:module';import {fileURLToPath} from 'node:url';
import ts from 'typescript';import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url);
const A='10000000-0000-4000-8000-000000000001',P='20000000-0000-4000-8000-000000000001',F='20000000-0000-4000-8000-000000000002';
function loadComponent(){const file=fileURLToPath(new URL('../components/platform-tenant-controls.js',import.meta.url));const mod=new Module(file);mod.filename=file;mod.require=name=>name.endsWith('.css')?new Proxy({},{get:(_,k)=>k==='__esModule'?false:k}):createRequire(file)(name);mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports.default;}
const base=()=>({version:'a'.repeat(64),tenant:{id:A,name:'منشأة اختبار أ',slug:'demo-a',status:'active',members:7,reefProtected:false},subscription:{id:A,planId:P,planName:'الأساسية',planKey:'core_basic',periodEnd:null,billingInterval:'month'},plans:[{id:P,key:'core_basic',name:'الأساسية',staffLimit:5,monthlyAmountMinor:7900,annualAmountMinor:79000,internalOnly:false},{id:F,key:'full',name:'النسخة الكاملة',staffLimit:null,internalOnly:true}],actions:{canSetPlan:true,canSetStatus:true,canDelete:true}});

test('actual React controller confirms before mutation, preserves identity, prevents double submit and reloads stale data',async t=>{
 const dom=new JSDOM('<button id="opener">open</button><div id="root"></div>',{url:'https://odeir.com',pretendToBeVisual:true});const descriptors=new Map();
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true})){descriptors.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});}
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 const {createElement:h,act}=require('react'),{createRoot}=require('react-dom/client');const root=createRoot(document.getElementById('root'));const Component=loadComponent();
 const requests=[],updates=[],deletes=[];const originalFetch=globalThis.fetch;let closed=0;
 globalThis.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}));
 t.after(async()=>{await act(()=>root.unmount());globalThis.fetch=originalFetch;dom.window.close();for(const [k,d] of descriptors){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 const click=async label=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===label);assert(b,`missing ${label}`);await act(()=>b.click());};
 const respond=async(data,ok=true)=>{const r=requests.shift();assert(r);await act(()=>r.resolve({ok,json:async()=>ok?{success:true,data}:{error:'تغيّرت بيانات المنشأة'}}));return r;};
 await act(()=>root.render(h(Component,{tenant:base().tenant,onClose:()=>closed++,onChanged:x=>updates.push(x),onDelete:x=>deletes.push(x)})));await respond(base());
 assert.match(document.body.textContent,/لن يُحذف أو يُعطّل أي مستخدم/);assert.equal(requests.length,0);
 const select=document.querySelector('[aria-label="الباقة الجديدة"]');await act(()=>{select.value=F;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(requests.length,0);
 await click('مراجعة تغيير الباقة');assert.equal(requests.length,0);assert.match(document.querySelector('[role="alert"]').textContent,/النسخة الكاملة/);
 await act(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='تأكيد التنفيذ');b.click();b.click();});assert.equal(requests.length,1);
 const payload=JSON.parse(requests[0].options.body);assert.equal(payload.tenantId,A);assert.equal(payload.payload.planId,F);assert.equal(payload.payload.expectedVersion,'a'.repeat(64));assert.equal(payload.payload.confirmation,'تغيير باقة demo-a');
 const next=base();next.version='b'.repeat(64);next.subscription={...next.subscription,planId:F,planName:'النسخة الكاملة',planKey:'full'};await respond(next);assert.equal(updates.length,1);
 await click('إيقاف المنشأة');assert.equal(requests.length,0);await click('تأكيد التنفيذ');assert.equal(JSON.parse(requests[0].options.body).payload.status,'suspended');await respond(null,false);
 assert.equal(document.querySelector('[aria-label="الباقة الجديدة"]').disabled,true);await click('إعادة تحميل التفاصيل');await respond(next);
 assert.equal(document.querySelector('[aria-label="الباقة الجديدة"]').disabled,false);await click('فتح معاينة الحذف');assert.equal(deletes[0].id,A);assert.equal(requests.length,0);
 await act(()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(closed,1);
});

test('route handlers require a session, enforce CSRF, validate responses and hide database internals',async t=>{
 const file=new URL('../app/api/platform/tenant-controls/route.js',import.meta.url);
 let src=readFileSync(file,'utf8').replace(/import .*?;\n/g,'');
 const helpers=new URL('../lib/tenant-controls-http.mjs',import.meta.url).href;
 src=`import {UUID,sameOrigin,boundedText,controlPayload,validControlSnapshot,publicControlError} from '${helpers}';\nconst NextResponse={json:(v,o)=>new Response(JSON.stringify(v),o)};const accessToken=async()=>globalThis.__fixtureTenantToken;const SUPABASE_URL='https://fixture.invalid';const SUPABASE_KEY='fixture';\n`+src;
 const route=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
 const originalFetch=globalThis.fetch;const oldToken=globalThis.__fixtureTenantToken;let hits=0;
 t.after(()=>{globalThis.fetch=originalFetch;if(oldToken===undefined)delete globalThis.__fixtureTenantToken;else globalThis.__fixtureTenantToken=oldToken;});
 globalThis.fetch=async()=>{hits++;return new Response(JSON.stringify(base()));};globalThis.__fixtureTenantToken=null;
 const url=`https://odeir.com/api/platform/tenant-controls?tenantId=${A}`;
 assert.equal((await route.GET(new Request(url))).status,401);assert.equal(hits,0);
 globalThis.__fixtureTenantToken='fixture';const get=await route.GET(new Request(url));assert.equal(get.status,200);assert.match(get.headers.get('cache-control'),/no-store/);
 const body={tenantId:A,action:'set_status',payload:{expectedVersion:'a'.repeat(64),status:'suspended',confirmation:'إيقاف demo-a'}};
 const request=origin=>new Request(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await route.POST(request('https://evil.invalid'))).status,403);
 globalThis.fetch=async()=>new Response(JSON.stringify({...base(),changed:true}));assert.equal((await route.POST(request('https://odeir.com'))).status,200);
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'tenant_controls_version_conflict'}),{status:400});assert.equal((await route.POST(request('https://odeir.com'))).status,409);
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'private_db_secret_value'}),{status:500});const failed=await route.POST(request('https://odeir.com'));assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/private_db_secret_value/);
 globalThis.fetch=async()=>new Response(JSON.stringify({...base(),tenant:{...base().tenant,id:'wrong'}}));assert.equal((await route.GET(new Request(url))).status,503);
});
