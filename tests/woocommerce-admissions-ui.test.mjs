import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import * as contract from '../lib/woocommerce-admissions.mjs';

test('Woo dialog reviews existing payments, preserves retry ID and submits only approved lines',async t=>{
  const dom=new JSDOM('<button id="opener">فتح</button><div id="root"></div>',{url:'https://fixture.invalid'});
  const previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,Event:dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const require=createRequire(import.meta.url),React=await import('react'),{createRoot}=await import('react-dom/client');
  const swc=require('next/dist/build/swc');await swc.loadBindings();
  const source=await readFile(new URL('../components/woocommerce-admission-modal.js',import.meta.url),'utf8');
  const {code}=await swc.transform(source,{filename:'woocommerce-admission-modal.js',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}});
  const compiled={exports:{}};
  new Function('module','exports','require',code)(compiled,compiled.exports,name=>name.endsWith('.module.css')
    ?new Proxy({},{get:(_,key)=>key==='__esModule'?false:String(key)}):name.endsWith('woocommerce-admissions.mjs')?contract:require(name));
  const Modal=compiled.exports.default,root=createRoot(document.getElementById('root'));
  const originalFetch=globalThis.fetch,writes=[];let resolveLoad,reviewed=false,failSave=true,saved=0;
  const base={enabled:true,revision:'r1',orderNumber:'9001',contactName:'عميل تجريبي',amountMinor:15000,paidAt:'2026-09-01T21:30Z',
    timeZone:'Asia/Riyadh',canReview:true,canComplete:true,reviewRequired:true,reviewValid:false,blockers:[],receipt:null,
    courses:[{id:'c1',name:'دورة أولى'},{id:'c2',name:'دورة ثانية'}],
    items:[{lineId:'101',title:'منتج أول',quantity:1,amountMinor:10000,suggestedCourseId:'c1'},
      {lineId:'102',title:'منتج ثان',quantity:1,amountMinor:5000,suggestedCourseId:'c2'}],
    candidates:[{id:'h1',courseId:'c1',courseName:'دورة أولى',reference:'9001',amountMinor:10000,status:'accepted'}]};
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('-context')){
      if(!reviewed)return new Promise(resolve=>{resolveLoad=()=>resolve({ok:true,json:async()=>({data:base})});});
      return {ok:true,json:async()=>({data:{...base,revision:'r2',reviewValid:true,reviewLines:writes.at(-1).p_lines}})};
    }
    writes.push(body);
    if(body.p_action==='review'){
      if(failSave)throw new Error('انقطع الاتصال');
      reviewed=true;return {ok:true,json:async()=>({data:{reviewed:true}})};
    }
    return {ok:true,json:async()=>({data:{completed:true}})};
  };
  t.after(async()=>{await React.act(async()=>root.unmount());globalThis.fetch=originalFetch;
    for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}dom.window.close();});
  document.getElementById('opener').focus();
  await React.act(async()=>root.render(React.createElement(Modal,{slug:'fixture',task:{id:'task'},onClose:()=>{},onSaved:()=>{saved++;}})));
  const button=text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text);
  const select=text=>[...document.querySelectorAll('label')].find(x=>x.textContent.startsWith(text))?.querySelector('select');
  const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
  const choose=async(element,value)=>React.act(async()=>{element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.match(document.body.textContent,/جارٍ تحميل/);
  await React.act(async()=>resolveLoad());
  assert.equal(select('التسجيل المرتبط بالبند 1').value,'h1');
  assert.equal(button('إتمام وإرسال للتسجيل').disabled,true);
  await React.act(async()=>{
    const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(textarea,'تمت مراجعة البلاغ السابق والبند الجديد');
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await click(button('اعتماد المراجعة والربط'));
  assert.match(document.body.textContent,/انقطع الاتصال/);assert.equal(saved,0);
  failSave=false;await click(button('اعتماد المراجعة والربط'));
  assert.equal(writes[0].p_command_id,writes[1].p_command_id);
  assert.equal(button('إتمام وإرسال للتسجيل').disabled,false);
  await choose(select('الدورة للبند 2'),'c1');
  assert.equal(button('إتمام وإرسال للتسجيل').disabled,true);
  await choose(select('الدورة للبند 2'),'c2');
  assert.equal(button('إتمام وإرسال للتسجيل').disabled,false);
  await click(button('إتمام وإرسال للتسجيل'));
  assert.equal(saved,1);assert.equal(writes.at(-1).p_expected_revision,'r2');
  assert.equal(writes.at(-1).p_lines[0].handoffId,'h1');
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('dir'),'rtl');
});
