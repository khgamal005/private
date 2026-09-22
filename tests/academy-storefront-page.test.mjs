import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {validAcademySlug} from '../lib/academy-policy.mjs';

function pageWith(result, error) {
 const source=readFileSync(new URL('../app/site/[tenantSlug]/courses/page.js',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{fileName:'page.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const exports={};
 vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`)(name=>{
  if(name==='next/navigation')return {notFound(){throw Object.assign(new Error('not found'),{status:404});}};
  if(name.endsWith('/academy-commerce-server'))return {getAcademyStorefront:async()=>{if(error)throw error;return result;}};
  if(name.endsWith('/academy-policy.mjs'))return {validAcademySlug};
  if(name.endsWith('/academy-storefront'))return {__esModule:true,default:'Storefront'};
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};
  throw new Error(`Unexpected dependency ${name}`);
 },{exports},exports);
 return ()=>exports.default({params:Promise.resolve({tenantSlug:'marktone'})});
}
test('disabled storefront returns not found even when the RPC maps its domain error to 409',async()=>{
 await assert.rejects(pageWith(null,{code:'academy_store_unavailable',status:409}),{status:404});
});
test('available storefront renders its data and infrastructure failures remain visible',async()=>{
 const data={offers:[]};assert.deepEqual((await pageWith(data)()).props.data,data);
 const failure=Object.assign(new Error('network'),{code:'network_unavailable',status:503});
 await assert.rejects(pageWith(null,failure),error=>error===failure);
});
