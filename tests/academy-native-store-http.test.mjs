import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as training from '../lib/training-request.mjs';
import * as academy from '../lib/academy-policy.mjs';
import * as commerce from '../lib/academy-commerce-policy.mjs';
const require=createRequire(import.meta.url),commandId='f4615892-715e-41ce-94df-7af33766857b';
const request=(body,{origin='https://odeir.com',site='same-origin',type='application/json'}={})=>new Request('https://odeir.com/api/academy-commerce/create_order',{method:'POST',headers:{origin,'sec-fetch-site':site,'content-type':type},body:JSON.stringify(body)});
function harness(){
 const calls=[],exports={};const source=readFileSync(new URL('../app/api/academy-commerce/[action]/route.js',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`,{filename:'academy-commerce/route.js'})(name=>{
  if(name.endsWith('/training-request.mjs'))return training;
  if(name.endsWith('/academy-policy.mjs'))return academy;
  if(name.endsWith('/academy-commerce-policy.mjs'))return commerce;
  if(name.endsWith('/training-server'))return {trainingJson:(body,status=200)=>({body,status}),trainingRpc:async(...args)=>{calls.push(args);return {ok:true};}};
  return require(name);
 },{exports},exports);return {...exports,calls};
}
const call=(h,action,body,options)=>h.POST(request(body,options),{params:Promise.resolve({action})});
test('anonymous course-order APIs still require same-origin bounded JSON and random access token',async()=>{
 for(const options of [{origin:'https://attacker.test'},{origin:''},{site:'cross-site'},{type:'text/plain'}]){
  const h=harness();const r=await call(h,'create_order',{tenantSlug:'marktone',commandId,payload:{accessToken:'ab'.repeat(32)}},options);assert.ok([403,415].includes(r.status));assert.equal(h.calls.length,0);
 }
 for(const payload of [{},{accessToken:'not-a-token'},{accessToken:'ab'.repeat(32),notes:'x'.repeat(30000)}]){
  const h=harness();assert.ok([400,413].includes((await call(h,'create_order',{tenantSlug:'marktone',commandId,payload})).status));assert.equal(h.calls.length,0);
 }
});
test('raw order token stays outside SQL; token hash cannot be overridden; money verification stays authenticated',async()=>{
 const h=harness(),token='4e'.repeat(32);
 const response=await call(h,'create_order',{tenantSlug:'marktone',commandId,payload:{accessToken:token,tokenHash:'evil',tenantId:commandId,actorSubjectId:commandId,offerId:commandId}});
 assert.equal(response.status,200);const [rpc,args,options]=h.calls[0];assert.equal(rpc,'v1_academy_store_order');assert.equal(options.publicAccess,true);
 assert.equal(args.p_payload.tokenHash,createHash('sha256').update(token).digest('hex'));assert.equal(args.p_payload.accessToken,undefined);assert.equal(args.p_payload.actorSubjectId,undefined);assert.equal(args.p_payload.tenantId,undefined);
 const privateRoute=harness();await call(privateRoute,'verify_order',{tenantSlug:'marktone',commandId,payload:{orderId:commandId}});
 assert.equal(privateRoute.calls[0][0],'v1_academy_commerce_action');assert.equal(privateRoute.calls[0][2].publicAccess,false);
});
test('invalid IDs, unbounded snapshot pages, missing command IDs and unknown actions stop before SQL',async()=>{
 for(const [action,body] of [['remove_tenant',{tenantSlug:'marktone',payload:{}}],['save_settings',{tenantSlug:'marktone',payload:{}}],['view_order',{tenantSlug:'marktone',payload:{orderId:'bad',accessToken:'ab'.repeat(32)}}],['snapshot',{tenantSlug:'marktone',payload:{offset:-1}}],['snapshot',{tenantSlug:'../../control',payload:{}}]]){
  const h=harness();assert.ok([400,404].includes((await call(h,action,body)).status));assert.equal(h.calls.length,0);
 }
});
