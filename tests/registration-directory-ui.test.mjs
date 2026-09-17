import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React, {act} from 'react';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/free-trial-landing.js',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{fileName:'registration.jsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const mod={exports:{}};new Function('require','module','exports',compiled)(require,mod,mod.exports);
const Component=mod.exports.default;
const response=value=>({ok:true,json:async()=>value});

test('registration search displays only the latest successful response',async t=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.test',pretendToBeVisual:true});
  const saved={};for(const key of ['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT','fetch'])saved[key]=globalThis[key];
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  const requests=[];
  globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  const text=()=>document.body.textContent;
  const change=async value=>act(async()=>{
    const input=document.querySelector('#institution-search');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  });
  const submit=async()=>act(async()=>document.querySelector('.search-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  try{
    await act(async()=>root.render(React.createElement(Component,{registrationOnly:true})));
    await t.test('an empty success shows the empty state',async()=>{
      await change('لا يوجد');await submit();await act(async()=>requests.at(-1).resolve(response({ok:true,results:[]})));
      assert.match(text(),/لم نجد منشأة مطابقة/);
    });
    await t.test('retry clears empty state while loading and has a deadline',async()=>{
      await submit();assert.doesNotMatch(text(),/لم نجد منشأة مطابقة/);assert.ok(requests.at(-1).options.signal);
      await act(async()=>requests.at(-1).resolve(response({ok:true,results:[{id:'one',name:'معهد القدرات للتدريب'}]})));
      assert.match(text(),/معهد القدرات للتدريب/);
    });
    await t.test('editing clears prior results and stale responses cannot replace current ones',async()=>{
      await change('قديمة');assert.doesNotMatch(text(),/معهد القدرات للتدريب/);await submit();const old=requests.at(-1);
      await change('جديدة');await submit();const fresh=requests.at(-1);
      await act(async()=>fresh.resolve(response({ok:true,results:[{id:'new',name:'المعهد الجديد'}]})));
      await act(async()=>old.resolve(response({ok:true,results:[{id:'old',name:'المعهد القديم'}]})));
      assert.match(text(),/المعهد الجديد/);assert.doesNotMatch(text(),/المعهد القديم/);
    });
    await t.test('changing a query cancels a pending institution selection',async()=>{
      await act(async()=>document.querySelector('.result-item').click());const details=requests.at(-1);
      await change('اسم آخر');
      await act(async()=>details.resolve(response({ok:true,institution:{id:'new',name:'اختيار قديم'}})));
      assert.ok(document.querySelector('.search-form'));assert.doesNotMatch(text(),/اختيار قديم/);
    });
    await t.test('failed requests display an error without claiming no matching institution',async()=>{
      await submit();await act(async()=>requests.at(-1).reject(new Error('timeout')));
      assert.ok(document.querySelector('[role="alert"]'));assert.doesNotMatch(text(),/لم نجد منشأة مطابقة/);
    });
    await t.test('malformed successful payloads are not treated as no matches',async()=>{
      await submit();await act(async()=>requests.at(-1).resolve(response({ok:true})));
      assert.ok(document.querySelector('[role="alert"]'));assert.doesNotMatch(text(),/لم نجد منشأة مطابقة/);
    });
    await t.test('moving to new registration prevents a pending search error affecting that form',async()=>{
      await submit();const pending=requests.at(-1);
      await act(async()=>document.querySelector('.new-institution').click());
      await act(async()=>pending.reject(new Error('service_unavailable')));
      assert.equal(document.querySelector('[role="alert"]'),null);
      assert.equal(document.querySelector('.search-form'),null);
    });
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
