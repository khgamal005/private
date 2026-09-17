import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const source=await readFile(new URL('../components/system-action-feedback.js',import.meta.url),'utf8');
const file=new URL('.google-kit-feedback-'+process.pid+'.mjs',import.meta.url);
await writeFile(file,ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
let Feedback;try{Feedback=(await import(file.href)).default;}finally{await unlink(file);}

test('Google Kit global alerts translate safe codes while unrelated API feedback keeps its existing behavior',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com',pretendToBeVisual:true});
 const keys=['window','document','Element','MutationObserver','requestAnimationFrame','IS_REACT_ACT_ENVIRONMENT'];
 const original=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,Element:dom.window.Element,MutationObserver:dom.window.MutationObserver,
  requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true});
 let code='ga4_admin_api_disabled';
 dom.window.fetch=async()=>Response.json({error:code,nextStep:'untrusted next step'},{status:403});
 const root=createRoot(document.getElementById('root'));
 t.after(async()=>{await act(async()=>root.unmount());dom.window.close();Object.assign(globalThis,original);});
 await act(async()=>root.render(React.createElement(Feedback)));
 for(const [error,message] of [['ga4_admin_api_disabled',/تحميل خصائص/],['ga4_data_api_disabled',/تقارير Analytics/],['ga4_access_denied',/رفض Google Analytics/],['PRIVATE provider error',/لم تكتمل الخطوة/]]){
  code=error;
  await act(async()=>{await dom.window.fetch('/api/tenant/google-ads/ga4-assets');});
  const alert=dom.window.document.querySelector('[role="alert"]').textContent;
  assert.match(alert,message);assert.doesNotMatch(alert,/ga4_|PRIVATE|untrusted next step|لمنح الصلاحية/);
 }
 code='original_other_error';
 await act(async()=>{await dom.window.fetch('/api/tenant/unrelated');});
 assert.match(dom.window.document.querySelector('[role="alert"]').textContent,/original_other_error/);
 assert.match(dom.window.document.querySelector('[role="alert"]').textContent,/untrusted next step/);
});
