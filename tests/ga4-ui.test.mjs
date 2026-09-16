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
async function mount(t,{report=data,config={configured:true,consentGranted:true,canManage:true,property:{name:'Synthetic',hostname:'store.example',timezone:'Asia/Riyadh'}},reject=false}={}) {
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com'});const original={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch,act:globalThis.IS_REACT_ACT_ENVIRONMENT};
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;const calls=[];
 globalThis.fetch=async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return Response.json(reject?{ok:false,error:'ga4_access_denied'}:{ok:true,...(url.endsWith('ga4-status')?config:report)},{status:reject?403:200});};
 const root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();globalThis.window=original.window;globalThis.document=original.document;globalThis.fetch=original.fetch;globalThis.IS_REACT_ACT_ENVIRONMENT=original.act;});
 await act(async()=>root.render(React.createElement(Report,{slug:'fixture',filters:{dateFrom:'2026-08-01',dateTo:'2026-08-02',asOf:'2026-09-01'},canManage:true,connected:true})));
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
 const {dom}=await mount(t,{reject:true});assert.match(dom.window.document.querySelector('[role="alert"]').textContent,/غير مخوّل/);assert.doesNotMatch(dom.window.document.body.textContent,/معاملات الشراء/);
});

