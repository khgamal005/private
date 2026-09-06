import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createRequire,Module} from 'node:module';import {fileURLToPath} from 'node:url';import path from 'node:path';
import ts from 'typescript';import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),cache=new Map();
function component(relative){const file=fileURLToPath(new URL(relative,import.meta.url));if(cache.has(file))return cache.get(file).exports;const mod=new Module(file),local=createRequire(file);mod.filename=file;mod.require=name=>{if(name.endsWith('.css'))return new Proxy({},{get:(_,key)=>key==='__esModule'?false:key==='default'?new Proxy({},{get:(_,k)=>k}):key});if(name.startsWith('.')&&path.resolve(path.dirname(file),name).includes('/components/'))return component(new URL(name+'.js',new URL(relative,import.meta.url)).href);return local(name);};cache.set(file,mod);mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}

test('actual React library pages, searches, handles stale replies, reads archived details and falls back from broken photos',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid',pretendToBeVisual:true});const original=new Map();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Node:dom.window.Node,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,IS_REACT_ACT_ENVIRONMENT:true})){original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 const {createElement:h,act}=require('react'),{createRoot}=require('react-dom/client');const root=createRoot(document.getElementById('root'));const Feed=component('../components/knowledge-feed.js').default;
 const previousFetch=globalThis.fetch,requests=[];
 globalThis.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}));
 t.after(async()=>{await act(()=>root.unmount());globalThis.fetch=previousFetch;dom.window.close();for(const [key,value] of original){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 const tick=()=>act(()=>new Promise(r=>setTimeout(r,330)));
 const request=async()=>{await tick();assert.ok(requests.length);return requests.shift();};
 const post={id:'10000000-0000-4000-8000-000000000001',title:'منافسة قديمة للتدريب',source_name:'مصدر رسمي',source_url:'https://example.gov.sa/news/1',cover_image_url:'https://example.gov.sa/broken.jpg',source_logo_url:'https://example.gov.sa/logo.svg',content_type:'tender',lifecycle:'expired',tender_deadline:'2026-01-01',published_at:'2026-01-01',relevance_score:85};
 const reply=async(req,{posts=[post],offset=0,total=267,error,body}={})=>{await act(()=>req.resolve({ok:!error,json:async()=>body||(error?{error}:{posts,categories:[],sources:[],stats:{total,expiredTenders:5,archived:5},pagination:{total,limit:24,offset,hasMore:offset+24<total,asOf:'2026-09-06T00:00:00Z'}})}));await tick();};
 const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent===label);
 const click=async x=>{assert.ok(x);await act(()=>x.click());};
 const fill=async(value)=>act(()=>{const input=document.querySelector('input[aria-label="البحث في كامل الأرشيف"]');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 await act(()=>root.render(h(Feed,{tenant:'demo'})));await reply(await request());
 assert.match(document.body.textContent,/٢٦٧/);
 const photo=document.querySelector('img');assert.match(photo.src,/broken.jpg/);await act(()=>photo.dispatchEvent(new dom.window.Event('error')));assert.match(document.querySelector('img').src,/logo.svg/);
 await click(button('التالي'));let req=await request();assert.match(req.url,/offset=24/);assert.match(req.url,/asOf=/);await reply(req,{offset:24});
 await click(button('المنافسات المنتهية'));req=await request();assert.match(req.url,/view=expired/);assert.match(req.url,/offset=0/);await reply(req,{total:5});
 await click(button('اقرأ التحليل'));req=await request();assert.match(req.url,/\/api\/knowledge\/post\?/);await reply(req,{body:{post:{...post,content:'تفاصيل المنافسة السابقة'}}});
 assert.match(document.querySelector('[role="dialog"]').textContent,/انتهى التقديم عليها/);assert.match(document.querySelector('[role="dialog"]').textContent,/تفاصيل المنافسة السابقة/);requests.shift(); // read event (no external traffic)
 await act(()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('[role="dialog"]'),null);
 await fill('بطيء');const slow=await request();await fill('سريع');const fast=await request();assert.equal(slow.options.signal.aborted,true);
 await reply(fast,{posts:[{...post,title:'النتيجة الصحيحة'}]});await reply(slow,{posts:[{...post,title:'نتيجة قديمة يجب تجاهلها'}]});assert.match(document.body.textContent,/النتيجة الصحيحة/);assert.doesNotMatch(document.body.textContent,/نتيجة قديمة يجب تجاهلها/);
 await click(button('تحديث المواد'));await reply(await request(),{error:'خطأ اختبار'});assert.match(document.body.textContent,/خطأ اختبار/);assert.doesNotMatch(document.body.textContent,/مرحبًا بكم في مركز/);
});
