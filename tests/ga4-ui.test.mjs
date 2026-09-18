import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const source=await readFile(new URL('../components/google-ga4-report.js',import.meta.url),'utf8');
const code=source.replace("import Link from 'next/link';","const Link=({href,children,...props})=><a href={href} {...props}>{children}</a>;").replace(/import styles from '[^']+';/,"const styles=new Proxy({}, {get:(_target,key)=>key});")
 .replaceAll("'../lib/google-ads/ui.mjs'",JSON.stringify(new URL('../lib/google-ads/ui.mjs',import.meta.url).href))
 .replaceAll("'../lib/google-ads/ga4-ui.mjs'",JSON.stringify(new URL('../lib/google-ads/ga4-ui.mjs',import.meta.url).href));
const file=new URL('.ga4-ui-'+process.pid+'.mjs',import.meta.url);
await writeFile(file,ts.transpileModule(code,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
let Report;try{Report=(await import(file.href)).default;}finally{await unlink(file);}
const data={configured:true,canReadMoney:true,canReadDetails:true,coverage:{complete:true,missingDays:0},summary:{transactions:1,matchedOrders:1,verifiedOrders:1,verifiedRegistrations:1,unmatched:0,pendingPayments:0,sessionAttributedOrders:1},traffic:{sessions:10,engagedSessions:8,checkouts:2},finances:[{currency:'SAR',netMinor:9000,collectionsMinor:10000,refundsMinor:1000}],rows:[{transactionId:'001',date:'2026-08-01',orderNumber:'001',status:'verified',currency:'SAR',netMinor:9000,amountCheck:'consistent_item_value',verifiedRegistrations:1}],campaigns:[],totalRows:1};
async function mount(t,{report=data,config={configured:true,consentGranted:true,canManage:true,property:{name:'Synthetic',hostname:'store.example',timezone:'Asia/Riyadh'}},reject=false,display='report',actionError='',streams=[]}={}) {
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com'});const original={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch,act:globalThis.IS_REACT_ACT_ENVIRONMENT};
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;const calls=[];
 globalThis.fetch=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});const error=reject?'ga4_access_denied':url.endsWith('ga4-assets')?actionError:'';return Response.json(error?{ok:false,error}:{ok:true,...(url.endsWith('ga4-status')?config:url.endsWith('ga4-streams')?{status:'success',streams}:report)},{status:error?403:200});};
 const root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();globalThis.window=original.window;globalThis.document=original.document;globalThis.fetch=original.fetch;globalThis.IS_REACT_ACT_ENVIRONMENT=original.act;});
 await act(async()=>root.render(React.createElement(Report,{slug:'fixture',filters:{dateFrom:'2026-08-01',dateTo:'2026-08-02',asOf:'2026-09-01'},canManage:true,connected:true,display})));
 return {dom,calls};
}
test('GA4 UI renders payment evidence, mobile labels and status filters',async t=>{
 const {dom,calls}=await mount(t);assert.match(dom.window.document.body.textContent,/دفع معتمد في أودير/);assert.match(dom.window.document.body.textContent,/صافي التحصيل المطابق/);
 const cells=[...dom.window.document.querySelectorAll('td')];assert.ok(cells.length>0);assert.ok(cells.every(td=>td.hasAttribute('data-label')));
 const select=dom.window.document.querySelector('select');await act(async()=>{select.value='verified';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 assert.equal(calls.filter(c=>c.url.endsWith('ga4-report')).at(-1).body.status,'verified');
});
test('GA4 UI hides financial/detail records when permissions are absent',async t=>{
 const {dom}=await mount(t,{report:{...data,canReadMoney:false,canReadDetails:false,rows:[],finances:[]}});assert.doesNotMatch(dom.window.document.body.textContent,/001|صافي التحصيل المطابق/);assert.match(dom.window.document.body.textContent,/تفاصيل الطلبات متاحة/);
});
test('GA4 UI shows safe actionable provider error instead of a false zero report',async t=>{
 const {dom}=await mount(t,{reject:true});assert.match(dom.window.document.querySelector('[role="alert"]').textContent,/رفض Google Analytics/);assert.doesNotMatch(dom.window.document.body.textContent,/معاملات الشراء/);
});
test('settings keep property retry available for disabled Admin API and show no raw error code',async t=>{
 const {dom}=await mount(t,{config:{configured:false,consentGranted:true},display:'settings',actionError:'ga4_admin_api_disabled'});
 await act(async()=>dom.window.document.querySelector('button').click());
 assert.match(dom.window.document.querySelector('[role="alert"]').textContent,/تحميل خصائص Analytics غير مفعلة/);
 assert.match(dom.window.document.querySelector('button').textContent,/اختيار خاصية GA4/);
 assert.doesNotMatch(dom.window.document.body.textContent,/ga4_admin_api_disabled/);
});
test('scope revocation exposes the GA4 reconnect button even when saved consent was previously granted',async t=>{
 const {dom}=await mount(t,{config:{configured:false,consentGranted:true},display:'settings',actionError:'ga4_consent_required'});
 await act(async()=>dom.window.document.querySelector('button').click());
 assert.match(dom.window.document.querySelector('button').textContent,/ربط GA4 مع جوجل/);
 assert.doesNotMatch(dom.window.document.body.textContent,/ga4_consent_required/);
});

test('a single site can be saved with no store and no commerce selection',async t=>{
 const {dom,calls}=await mount(t,{display:'settings',config:{configured:false,consentGranted:true,properties:[{id:'1234',name:'Site'}],stores:[]},streams:[{id:'5678',name:'Website',hostname:'site.example'}]});
 await act(async()=>dom.window.document.querySelector('button').click());
 const save=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='حفظ ربط التحليلات');assert.equal(save.disabled,false);
 assert.doesNotMatch(dom.window.document.body.textContent,/اربط متجر WooCommerce.*أولًا/);assert.equal(dom.window.document.querySelectorAll('select').length,2);
 await act(async()=>save.click());
 const sent=calls.find(c=>c.url.endsWith('ga4-select'));assert.equal(sent.body.propertyId,'1234');assert.equal(sent.body.streamId,'5678');assert.equal(sent.body.connectionId,null);
});
test('multiple web streams require an explicit site choice',async t=>{
 const {dom,calls}=await mount(t,{display:'settings',config:{configured:false,consentGranted:true,properties:[{id:'1234',name:'Site'}],stores:[]},streams:[{id:'5678',name:'First',hostname:'one.example'},{id:'7777',name:'Second',hostname:'two.example'}]});
 await act(async()=>dom.window.document.querySelector('button').click());
 const save=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='حفظ ربط التحليلات');assert.equal(save.disabled,true);
 const site=dom.window.document.querySelectorAll('select')[1];await act(async()=>{site.value='7777';site.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 assert.equal(save.disabled,false);await act(async()=>save.click());assert.equal(calls.find(c=>c.url.endsWith('ga4-select')).body.streamId,'7777');
});
test('a property without web streams cannot be saved and offers a clear retry',async t=>{
 const {dom,calls}=await mount(t,{display:'settings',config:{configured:false,consentGranted:true,properties:[{id:'1234',name:'Site'}],stores:[]}});
 await act(async()=>dom.window.document.querySelector('button').click());
 assert.match(dom.window.document.body.textContent,/لا يوجد مسار بيانات ويب/);
 assert.equal([...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='حفظ ربط التحليلات').disabled,true);
 await act(async()=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='إعادة تحميل المواقع').click());
 assert.equal(calls.filter(c=>c.url.endsWith('ga4-streams')).length,2);
});
test('optional source editing is separate and explicitly supports detaching commerce while keeping Analytics',async t=>{
 const connectionId='20000000-0000-4000-8000-000000000001';
 const {dom,calls}=await mount(t,{display:'settings',config:{configured:true,consentGranted:true,property:{id:'1234',streamId:'5678',hostname:'site.example'},stores:[{id:connectionId,url:'https://site.example'}],reconciliation:{enabled:true,provider:'woocommerce',connectionId}}});
 await act(async()=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='إعداد مصدر الطلبات').click());
 const select=dom.window.document.querySelector('select');assert.equal(select.value,connectionId);
 await act(async()=>{select.value='';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 await act(async()=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='حفظ مصدر المطابقة').click());
 const sent=calls.find(c=>c.url.endsWith('ga4-select'));assert.equal(sent.body.connectionId,null);assert.equal(sent.body.propertyId,'1234');assert.equal(sent.body.streamId,'5678');
});
test('standalone report leads with measured activity and hides finance, matching issues and false zero outcomes',async t=>{
 const {dom}=await mount(t,{report:{...data,reconciliation:{enabled:false},traffic:{sessions:10,engagedSessions:8,pageViews:20,purchases:2},trafficSources:[{source:'google',medium:'cpc',sessions:10,engagedSessions:8,pageViews:20,purchases:2}],trafficSourceCount:1}});
 const body=dom.window.document.body.textContent;
 assert.match(body,/جلسات الموقع/);assert.match(body,/مشاهدات الصفحات/);assert.match(body,/غير متاح في هذا التقرير/);assert.match(body,/google \/ cpc/);
 assert.doesNotMatch(body,/صافي التحصيل المطابق|طلبات بدفع معتمد|دليل المطابقة لكل معاملة|طلبًا مطابقًا ينتظر/);
 assert.equal(dom.window.document.querySelectorAll('select').length,0);
 assert.ok([...dom.window.document.querySelectorAll('td')].every(td=>td.hasAttribute('data-label')));
});

test('unrequested transaction details are displayed as unavailable without hiding measured purchases',async t=>{
 const {dom}=await mount(t,{report:{...data,reconciliation:{enabled:false},coverage:{complete:true,missingDays:0,transactionReportAvailable:false},
  summary:{transactions:null},traffic:{sessions:10,engagedSessions:8,pageViews:20,purchases:3}}});
 const cards=[...dom.window.document.querySelectorAll('article')];
 const transactions=cards.find(card=>card.querySelector('span')?.textContent==='معاملات الشراء');
 assert.match(transactions.querySelector('strong').textContent,/غير متاح/);
 assert.match(transactions.textContent,/تفعيل المطابقة الاختيارية/);
 const purchases=cards.find(card=>card.querySelector('span')?.textContent==='أحداث الشراء في GA4');
 assert.doesNotMatch(purchases.querySelector('strong').textContent,/غير متاح/);
 assert.doesNotMatch(dom.window.document.body.textContent,/Google أعاد بيانات محدودة/);
});
