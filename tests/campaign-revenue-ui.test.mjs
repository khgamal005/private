import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {campaignFilters} from '../lib/campaign-revenue.mjs';

test('review UI renders RTL, previews a group, releases errors and replays the same command safely',async()=>{
 const require=createRequire(import.meta.url);
 let source=await readFile(new URL('../components/campaign-revenue-report.js',import.meta.url),'utf8');
 source=source.replace("import CampaignRecommendations from './campaign-recommendations';","const CampaignRecommendations=()=>null;").replace("import CampaignOpportunityCollections from './campaign-opportunity-collections';","const CampaignOpportunityCollections=()=>null;").replace("import './campaign-revenue-report.css';",'')
  .replace("import Link from 'next/link';","const Link=({href,children,...props})=><a href={href} {...props}>{children}</a>;")
  .replace("import {useRouter} from 'next/navigation';","const useRouter=()=>({refresh(){}});");
 let code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>`from ${JSON.stringify(name.startsWith('../')?new URL(name,new URL('../components/campaign-revenue-report.js',import.meta.url)).href:pathToFileURL(require.resolve(name)).href)}`);
 const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com/tenant/fixture/reports/campaigns'});
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client');
 const target='20000000-0000-4000-8000-000000000001';
 let attempts=0;const commands=[];
 globalThis.fetch=async(_url,options={})=>{
  if(!options.method)return {ok:true,json:async()=>({total:2,offset:0,batches:[],targets:[{id:target,name:'Training',accountName:'Account',externalId:'123'}],
   rows:[1,2].map(i=>({key:'import:'+i,token:'token'+i,campaignName:'Training',source:'meta',evidence:'unreviewed'}))})};
  commands.push(JSON.parse(options.body));attempts++;
  return {ok:attempts>1,json:async()=>attempts>1?{ok:true}:{error:'service_unavailable'}};
 };
 const data={groups:[],summary:{leads:0,payers:0},range:{timezone:'Asia/Riyadh'},staff:[],courses:[],details:[],totalDetails:0,canReview:true,canReadDetails:true,canReadMoney:false};
 const root=createRoot(document.getElementById('root'));
 try{
  await act(()=>root.render(React.createElement(Component,{slug:'fixture',data,filters:campaignFilters({},new Date('2026-09-06'))})));
  assert.equal(document.querySelector('main').getAttribute('dir'),'rtl');
  assert.match(document.body.textContent,/لا توجد بيانات أودير مطابقة/);
  assert.match(document.body.textContent,/تفاصيل التحصيل تحتاج صلاحية/);
  const preview=[...document.querySelectorAll('button')].find(e=>e.textContent==='معاينة المصادر');
  await act(()=>preview.click());
  const form=document.querySelector('.cr-review');assert.ok(form);assert.equal(form.querySelector('select').value,target);
  const reason=form.querySelector('input[required]');
  await act(()=>{
   Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(reason,'Reviewed sheet campaign');
   reason.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  });
  await act(()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.match(document.body.textContent,/يمكنك إعادة المحاولة بأمان/);assert.equal(form.querySelector('button').disabled,false);
  await act(()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(commands.length,2);assert.equal(commands[0].commandId,commands[1].commandId);
  assert.equal(commands[0].rows.length,2);assert.equal(commands[0].campaignId,target);
  assert.equal(commands[0].reason,'Reviewed sheet campaign');
  assert.equal(new URL(document.querySelector('a[href*="action=export"]').href).searchParams.get('mode'),'cohort');
 }finally{await act(()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
