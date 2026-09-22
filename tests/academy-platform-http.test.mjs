import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as admin from '../lib/academy-admin.mjs';
import * as policy from '../lib/training-request.mjs';
import * as navigation from '../lib/academy-navigation.mjs';

const require=createRequire(import.meta.url),commandId='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269';
function load(path,stubs){
  const exports={},source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:path})(name=>{
    const key=Object.keys(stubs).find(key=>name.endsWith(key));return key?stubs[key]:require(name);
  },{exports},exports);return exports;
}
function route(){
  const calls=[];
  const handler=load('app/api/platform/academy-controls/route.js',{
    '/academy-admin.mjs':admin,'/training-request.mjs':policy,
    '/training-server':{trainingJson:(body,status=200)=>({body,status}),trainingRpc:async(...args)=>{calls.push(args);return {tenants:[]};}}
  });return {...handler,calls};
}
const request=(body,headers={})=>new Request('https://odeir.com/api/platform/academy-controls',{method:'POST',headers:{origin:'https://odeir.com','sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:JSON.stringify(body)});
const configuration={expectedVersion:0,enabled:true,mode:'standalone',components:{lms:true,website:true,store:true},accessUntil:null,reason:'Approved standalone setup'};

test('academy admin HTTP rejects malformed/cross-site mutations before the database',async()=>{
  const base={slug:'marktone',action:'configure',commandId,payload:configuration};
  for(const [body,headers] of [[base,{origin:'https://attacker.example'}],[base,{'sec-fetch-site':'cross-site'}],[{...base,commandId:null},{}],[{...base,slug:'../reef'},{}],[{...base,action:'delete'},{}],[{...base,payload:{...configuration,expectedVersion:0.5}},{}]]){
    const h=route(),result=await h.POST(request(body,headers));assert.ok(result.status>=400);assert.equal(h.calls.length,0);
  }
});

test('academy configuration keeps concurrency version and command but strips actor and tenant overrides',async()=>{
  const h=route();const result=await h.POST(request({slug:'marktone',action:'configure',commandId,payload:{...configuration,tenantId:'foreign',actorSubjectId:commandId,amountMinor:1}}));
  assert.equal(result.status,200);assert.deepEqual(h.calls,[['v1_platform_academy_action',{p_slug:'marktone',p_action:'configure',p_command_id:commandId,p_payload:configuration}]]);
});

test('team invitation secret is hashed for storage and returned only in fragment; retry keeps identity',async()=>{
  const h=route(),token='ab'.repeat(32),expiresAt='2026-09-29T10:00:00.000Z';
  const body={slug:'marktone',action:'issue_invitation',commandId,invitationToken:token,payload:{email:'MANAGER@example.test',role:'manager',expiresAt,tokenHash:'injected'}};
  const first=await h.POST(request(body)),second=await h.POST(request(body));
  assert.equal(first.status,200);assert.equal(first.body.invitationUrl,`/academy/accept?tenant=marktone#${token}`);
  assert.deepEqual(first,second);assert.deepEqual(h.calls[0],h.calls[1]);
  assert.equal(h.calls[0][1].p_payload.tokenHash,createHash('sha256').update(token).digest('hex'));
  assert.equal(h.calls[0][1].p_payload.email,'manager@example.test');assert.equal(JSON.stringify(h.calls).includes(token),false);
});

test('invalid invitations, roles, and malformed settings never reach privileged function',async()=>{
  const payloads=[['issue_invitation',{email:'ok@example.test',role:'owner',expiresAt:'2026-09-23'}],['set_member',{email:'ok@example.test',role:'manager',status:'deleted'}],['configure',{...configuration,components:{lms:true}}],['configure',{...configuration,accessUntil:'not-a-date'}]];
  for(const [action,payload] of payloads){const h=route(),result=await h.POST(request({slug:'marktone',commandId,action,payload}));assert.equal(result.status,400);assert.equal(h.calls.length,0);}
});

test('academy read scopes the selected tenant and never accepts a global account listing',async()=>{
  const h=route();assert.equal((await h.GET(new Request('https://odeir.com/api/platform/academy-controls'))).status,400);
  assert.equal((await h.GET(new Request('https://odeir.com/api/platform/academy-controls?slug=marktone'))).status,200);
  assert.deepEqual(h.calls,[['v1_platform_academy_snapshot',{p_slug:'marktone'}]]);
});

test('academy proxy preserves public entry/checkout and protects manager APIs with refresh',async()=>{
  const {proxy}=load('proxy.js',{'next/server':{NextResponse:{next:()=>({next:true}),json:(body,opts)=>({body,...opts}),redirect:url=>({redirect:url.href})}},'./lib/config':{ACCESS_COOKIE:'access',REFRESH_COOKIE:'refresh',SUPABASE_URL:'https://example.invalid',SUPABASE_KEY:'public'}});
  const req=path=>{const url=new URL('https://odeir.com'+path);return {nextUrl:{pathname:url.pathname,search:url.search,searchParams:url.searchParams,clone:()=>new URL(url)},cookies:{get:()=>undefined}};};
  for(const path of ['/academy/login','/academy/accept','/academy/confirmed','/training/login','/training/accept','/api/academy-commerce/create_order','/api/academy-commerce/view_order','/api/academy-commerce/report_transfer','/api/cms/public-contact','/api/cms/templates/runtime','/api/cms/templates/native'])assert.deepEqual(await proxy(req(path)),{next:true});
  const denied=await proxy(req('/api/academy-commerce/verify_order'));assert.equal(denied.status,401);
  const destination=new URL((await proxy(req('/academy/marktone/website'))).redirect);
  assert.equal(destination.pathname,'/academy/login');assert.equal(destination.searchParams.get('tenant'),'marktone');
  const learner=new URL((await proxy(req('/training/marktone?workspace=academy&role=instructor'))).redirect);
  assert.equal(learner.pathname,'/training/login');assert.equal(learner.searchParams.get('workspace'),'academy');assert.equal(learner.searchParams.get('role'),'instructor');
  assert.equal((await proxy(req('/api/cms/builder/save'))).status,401);
  assert.equal((await proxy(req('/api/academy-schedule/save_session'))).status,401);
  const preview=new URL((await proxy(req('/cms-preview/tenant%3Amarktone/page/example?workspace=academy'))).redirect);
  assert.equal(preview.pathname,'/academy/login');assert.equal(preview.searchParams.get('tenant'),'marktone');
});

test('legacy navigation redirects only eligible pilot views and leaves other tenants independent',async()=>{
  let reads=0,access=null;
  const h=load('lib/academy-legacy.js',{'next/navigation':{redirect:path=>{throw Error(`redirect:${path}`);}},'/academy-server':{readAcademyAccess:async()=>{reads++;return access;}},'/academy-navigation.mjs':navigation});
  await h.redirectLegacyAcademy('reefskills');assert.equal(reads,0);
  await h.redirectLegacyAcademy('marktone');
  access={enabled:true,tenant:{slug:'marktone'},mode:'standalone',odeirAccess:false,components:{lms:true,website:true},permissions:{manageLearning:true,manageWebsite:true}};
  await assert.rejects(h.redirectLegacyAcademy('marktone',{view:'courses'}),/redirect:\/academy\/marktone\/lms\/courses/);
  await h.redirectLegacyAcademy('marktone',{view:'admissions'});
  await assert.rejects(h.redirectLegacyAcademy('marktone',{section:'website',entityType:'page',entityId:'item-1'}),/redirect:\/academy\/marktone\/website\/builder\/page\/item-1/);
  access={...access,permissions:{}};await h.redirectLegacyAcademy('marktone',{section:'website'});
  access={...access,enabled:false,permissions:{manageLearning:true}};await h.redirectLegacyAcademy('marktone');
});
