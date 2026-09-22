import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {academyBasePath} from '../lib/academy-navigation.mjs';
import {academyLoginPath} from '../lib/academy-policy.mjs';

const require=createRequire(import.meta.url);
const token='c'.repeat(64);
const code=ts.transpileModule(readFileSync(new URL('../components/academy-invitation-form.js',import.meta.url),'utf8'),{
  fileName:'academy-invitation.jsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}
}).outputText;

async function render(t,url,{previewError=false}={}){
  const dom=new JSDOM('<div id="root"></div>',{url,pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','FormData','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true});
  const requests=[],navigations=[];
  globalThis.fetch=async(url,init)=>{
    requests.push({url,body:JSON.parse(init.body)});
    if(previewError&&url.endsWith('/preview'))return {ok:false,json:async()=>({error:'الدعوة غير متاحة للمعاينة.'})};
    return {ok:true,json:async()=>url.endsWith('/preview')?{email:'invitee@example.test',role:'instructor'}:url.endsWith('/register')?{success:true,confirmationRequired:true}:{success:true,next:'/training/marktone?workspace=academy&role=instructor'}};
  };
  const mod={exports:{}};
  new Function('require','module','exports',code)(name=>{
    if(name.endsWith('/academy-navigation.mjs'))return {academyBasePath};
    if(name.endsWith('/full-document-navigation.mjs'))return {replaceDocument:(...args)=>navigations.push(args)};
    return require(name);
  },mod,mod.exports);
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  t.after(async()=>{
    await act(async()=>root.unmount());dom.window.close();
    for(const key of keys){if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];}
  });
  await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(mod.exports.default,{tenantSlug:'marktone'}))));
  return {dom,requests,navigations};
}

test('invitation UI removes bearer from URL and survives repeated effects while keeping only in-memory secret',async t=>{
  const h=await render(t,`https://odeir.com/academy/accept?tenant=marktone&discard=unused#${token}`);
  assert.equal(window.location.href,'https://odeir.com/academy/accept?tenant=marktone');
  assert.ok(h.requests.length>=1);assert.ok(h.requests.every(request=>request.url==='/api/academy-invitations/preview'));
  for(const request of h.requests)assert.deepEqual(request.body,{tenantSlug:'marktone',token});
  assert.equal(document.querySelector('input[type="email"]').value,'invitee@example.test');
  assert.equal(document.querySelector('input[type="email"]').readOnly,true);
  assert.equal(document.body.innerHTML.includes(token),false);
  assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  const button=text=>[...document.querySelectorAll('button')].find(value=>value.textContent===text);
  await act(async()=>button('إنشاء حساب').click());
  document.querySelector('input[name="password"]').value='New password 123456';
  await act(async()=>document.querySelector('form').dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(h.requests.at(-1).url,'/api/academy-invitations/register');
  assert.deepEqual(h.requests.at(-1).body,{tenantSlug:'marktone',token,password:'New password 123456'});
  assert.match(document.body.textContent,/أكد الحساب.*رابط الدعوة الأصلي/);
  assert.equal(h.navigations.length,0);
  assert.equal(document.querySelector('input[name="password"]').value,'');
  document.querySelector('input[name="password"]').value='Confirmed password 123';
  await act(async()=>document.querySelector('form').dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(h.requests.at(-1).url,'/api/academy-invitations/login');
  assert.equal(h.navigations[0][0],'/training/marktone?workspace=academy&role=instructor');
  assert.ok([...document.querySelectorAll('a')].every(a=>!a.href.includes(token)));
});

test('opening an incomplete invitation does not send preview, offer account creation or expose credentials fields',async t=>{
  const h=await render(t,'https://odeir.com/academy/accept?tenant=marktone#invalid');
  assert.equal(h.requests.length,0);assert.equal(window.location.hash,'');
  assert.match(document.body.textContent,/رابط الدعوة غير مكتمل/);
  assert.equal(document.querySelector('input[type="password"]'),null);
});

test('an already accepted invitation can retry with authenticated login after its pending-only preview fails',async t=>{
  const h=await render(t,`https://odeir.com/academy/accept?tenant=marktone#${token}`,{previewError:true});
  const email=document.querySelector('input[name="email"]');
  assert.equal(email.readOnly,false);email.value='invitee@example.test';
  assert.equal([...document.querySelectorAll('button')].some(value=>value.textContent==='إنشاء حساب'),false);
  document.querySelector('input[name="password"]').value='Same confirmed password';
  await act(async()=>document.querySelector('form').dispatchEvent(new h.dom.window.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(h.requests.at(-1).url,'/api/academy-invitations/login');
  assert.deepEqual(h.requests.at(-1).body,{tenantSlug:'marktone',token,email:'invitee@example.test',password:'Same confirmed password'});
  assert.equal(h.navigations.length,1);
});

test('confirmation landing scrubs provider credentials without consuming them or claiming email verification',async t=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.com/academy/confirmed?tenant=marktone&type=training&token_hash=secret-hash&code=secret-code#access_token=secret-access&refresh_token=secret-refresh',pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  const requests=[];globalThis.fetch=(...args)=>{requests.push(args);throw Error('Confirmation must not use credentials');};
  const compiled=ts.transpileModule(readFileSync(new URL('../components/academy-confirmation-notice.js',import.meta.url),'utf8'),{
    fileName:'academy-confirmation.jsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}
  }).outputText;
  const mod={exports:{}};
  new Function('require','module','exports',compiled)(name=>name.endsWith('/academy-policy.mjs')?{academyLoginPath}:require(name),mod,mod.exports);
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(document.getElementById('root'));
  t.after(async()=>{
    await act(async()=>root.unmount());dom.window.close();
    for(const key of keys){if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];}
  });
  await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(mod.exports.default,{tenantSlug:'marktone',training:true}))));
  assert.equal(window.location.href,'https://odeir.com/academy/confirmed?tenant=marktone');
  assert.equal(requests.length,0);assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);
  assert.equal(document.body.innerHTML.includes('secret-'),false);
  assert.match(document.body.textContent,/بعد تأكيد بريدك الإلكتروني/);
  assert.doesNotMatch(document.body.textContent,/تم تأكيد/);
  assert.equal(document.querySelector('a').getAttribute('href'),'/training/login?tenant=marktone&workspace=academy&role=learner');
});
