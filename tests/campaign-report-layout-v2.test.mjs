import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),cache=new Map();
async function component(path){
 const file=new URL(path,import.meta.url);
 async function compile(url){
  if(cache.has(url.href))return cache.get(url.href);
  let source=await readFile(url,'utf8');
  source=source.replace(/import (\w+) from ['"]next\/link['"];?/g,(_m,n)=>`const ${n}=({href,children,...props})=><a href={href} {...props}>{children}</a>;`)
   .replace(/import (\w+) from ['"]next\/image['"];?/g,(_m,n)=>`const ${n}=props=><img {...props}/>;`)
   .replace(/import \{useRouter\} from ['"]next\/navigation['"];?/g,'const useRouter=()=>({refresh(){},push(){}});')
   .replace(/import (\w+) from ['"][^'"]+\.css['"];?/g,(_m,n)=>`const ${n}=new Proxy({},{get:(_t,k)=>k});`)
   .replace(/import ['"][^'"]+\.css['"];?/g,'');
  let code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const [,name] of [...code.matchAll(/from ['"]([^'"]+)['"]/g)]){
   let target;
   if(name.startsWith('.')){const dep=new URL(name,url);if(!/\.(?:js|mjs)$/.test(dep.pathname))dep.pathname+='.js';target=dep.pathname.endsWith('.mjs')?dep.href:await compile(dep);}
   else target=pathToFileURL(require.resolve(name)).href;
   code=code.replace(`from "${name}"`,`from ${JSON.stringify(target)}`).replace(`from '${name}'`,`from ${JSON.stringify(target)}`);
  }
  const compiled='data:text/javascript;base64,'+Buffer.from(code).toString('base64');cache.set(url.href,compiled);return compiled;
 }
 return (await import(await compile(file))).default;
}
test('Google settings and reporting render as separate journeys with GA4 independent of Ads selection',async()=>{
 const Google=await component('../components/google-ads-connect.js');
 const common={slug:'fixture',initialData:{enabled:true,addonEnabled:true,canManage:true,status:'connected'},filters:{dateFrom:'2026-09-01',dateTo:'2026-09-15',asOf:'2026-09-16',today:'2026-09-16',page:1}};
 const report=new JSDOM(renderToStaticMarkup(React.createElement(Google,common))).window.document;
 const settings=new JSDOM(renderToStaticMarkup(React.createElement(Google,{...common,display:'settings'}))).window.document;
 const buttons=doc=>[...doc.querySelectorAll('button')].map(b=>b.textContent).join('|');
 assert.doesNotMatch(buttons(report),/إعادة ربط|فصل الربط|تغيير الحساب|ربط GA4 مع جوجل|مراجعة مصادر الملفات/);
 assert.match(buttons(settings),/إعادة ربط جوجل/);assert.match(buttons(settings),/ربط GA4 مع جوجل/);
 assert.ok(report.querySelector('a[href="/tenant/fixture/addons/google-kit"]'));
 assert.equal(settings.querySelector('nav[aria-label="منصات تقارير الحملات"]'),null);
 assert.ok(settings.querySelector('#ga4-title'));assert.ok(report.querySelector('#ga4-title'));
});
test('Meta report contains no connection controls and puts metrics ahead of ad detail',async()=>{
 const Meta=await component('../components/social-connect-v2.js');
 const html=renderToStaticMarkup(React.createElement(Meta,{slug:'fixture',display:'performance',canManage:true,initialData:{status:'connected',addonEnabled:true,rolloutEnabled:true,oauthEnabled:true,selectedAccount:{currency:'SAR'},syncEnabled:true},initialReport:{summary:{spendMinor:1000,platformConversions:2,clicks:3},campaigns:[],ads:[],filters:{}},reportFilters:{dateFrom:'2026-09-01',dateTo:'2026-09-15',today:'2026-09-16'}}));
 const doc=new JSDOM(html).window.document;
 const buttons=[...doc.querySelectorAll('button')].map(b=>b.textContent).join('|');
 assert.doesNotMatch(buttons,/فصل الربط|ربط حساب|اختيار الحساب/);assert.match(buttons,/مزامنة سريعة/);
 assert.ok(doc.querySelector('input[name="platform"][value="meta"]'));
 assert.ok(html.indexOf('ملخص الفترة المختارة')<html.indexOf('تفاصيل الإعلانات'));
});
