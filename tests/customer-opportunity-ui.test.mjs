import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import * as timing from '../lib/task-timing.mjs';

test('new opportunity uses existing contact, explicit source, optional schedule and retry command',async t=>{
  const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://fixture.local'});
  const previous=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
    Event:dom.window.Event,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const require=createRequire(import.meta.url);
  const React=await import('react');const {createRoot}=await import('react-dom/client');
  const swc=require('next/dist/build/swc');await swc.loadBindings();
  const source=await readFile(new URL('../components/customer-opportunity-modal.js',import.meta.url),'utf8');
  const {code}=await swc.transform(source,{filename:'customer-opportunity-modal.js',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}});
  const compiled={exports:{}};
  new Function('module','exports','require',code)(compiled,compiled.exports,name=>name.endsWith('task-timing.mjs')?timing:require(name));
  const Modal=compiled.exports.default;const root=createRoot(document.getElementById('root'));
  const requests=[];const originalFetch=globalThis.fetch;let saved='';let fail=true;
  globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:!fail,json:async()=>fail?{error:'Synthetic retry'}:{data:{id:'new-opportunity',taskId:null}}};};
  t.after(async()=>{await React.act(async()=>root.unmount());globalThis.fetch=originalFetch;for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}dom.window.close();});
  await React.act(async()=>root.render(React.createElement(Modal,{slug:'fixture',contact:{id:'existing-contact',name:'Synthetic'},courses:[{id:'course-1',nameAr:'Course'}],timeZone:'Asia/Riyadh',onClose(){},onSaved(message){saved=message;}})));
  document.querySelector('[name="title"]').value='New diploma opportunity';
  document.querySelector('[name="course_id"]').value='course-1';
  document.querySelector('[name="value"]').value='30000';
  await React.act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests[0].url,'/api/tenant/create-opportunity');assert.equal(requests[0].body.p_contact_id,'existing-contact');
  assert.equal(requests[0].body.p_course_id,'course-1');assert.equal(requests[0].body.p_value_minor,3000000);
  assert.equal(requests[0].body.p_next_action_at,null);assert.equal(requests[0].body.p_next_action_type,null);assert.equal(requests[0].body.p_source,null);
  assert.ok(document.querySelector('[role="alert"]').textContent.includes('Synthetic retry'));
  fail=false;await React.act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests[0].body.p_command_id,requests[1].body.p_command_id);assert.ok(saved.includes('لاحقًا'));
  document.querySelector('[name="next_action_type"]').value='call';
  await React.act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests.length,2);assert.ok(document.querySelector('[role="alert"]').textContent.includes('معًا'));
});
