import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../lib/training-request.mjs';

const require=createRequire(import.meta.url);
const commandId='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269';
function req(body,{origin='https://odeir.com',site='same-origin',contentType='application/json'}={}){
  return new Request('https://odeir.com/api/training/snapshot',{method:'POST',headers:{origin,'sec-fetch-site':site,'content-type':contentType},body:JSON.stringify(body)});
}
function harness(path,stubs){
  const exports={};const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:path})(name=>{
    const key=Object.keys(stubs).find(k=>name.endsWith(k));
    return key?stubs[key]:require(name);
  },{exports},exports);
  return exports;
}
function route(){
  const calls=[];
  const routeModule=harness('app/api/training/[action]/route.js',{
    '/training-request.mjs':policy,
    '/training-server':{
      trainingJson:(body,status=200)=>({body,status}),
      trainingFailure:error=>({body:{error:policy.trainingErrorMessage(error.code)},status:error.status||503}),
      trainingRpc:async(...args)=>{calls.push(args);return {success:true};}
    },
    '/training-snapshot':{getTrainingSnapshot:async(...args)=>{calls.push(['snapshot',...args]);return {role:args[1].role};}}
  });
  return {...routeModule,calls};
}

test('training mutations reject missing/cross-site origins and unsupported payloads before any RPC',async()=>{
  for(const settings of [{origin:'https://attacker.example'},{origin:''},{site:'cross-site'},{origin:'https://odeir.com.evil.example'},{contentType:'text/plain'}]){
    const h=route();const result=await h.POST(req({tenantSlug:'marktone',commandId,payload:{}},settings),{params:Promise.resolve({action:'confirm_admission'})});
    assert.ok([403,415].includes(result.status));assert.equal(h.calls.length,0);
  }
});

test('training body reader applies an actual streamed byte limit without trusting content length',async()=>{
  await assert.rejects(policy.readTrainingBody(req({text:'س'.repeat(16000)})),error=>error.status===413);
  for(const body of [[],null,42,'str'])await assert.rejects(policy.readTrainingBody(req(body)),error=>error.status===400);
});

test('another tenant and unknown actions cannot reach the database even with a valid command',async()=>{
  for(const [action,tenantSlug] of [['confirm_admission','reefskills'],['drop_table','marktone'],['accept_invitation','marktone']]){
    const h=route();const result=await h.POST(req({tenantSlug,commandId,payload:{}}),{params:Promise.resolve({action})});
    assert.ok([400,404].includes(result.status));assert.equal(h.calls.length,0);
  }
});

test('mutation command identities are mandatory but read-only snapshots do not require one',async()=>{
  const h=route();const failed=await h.POST(req({tenantSlug:'marktone'}),{params:Promise.resolve({action:'submit_assignment'})});
  assert.equal(failed.status,400);assert.equal(h.calls.length,0);
  const read=await h.POST(req({tenantSlug:'marktone',payload:{role:'learner'}}),{params:Promise.resolve({action:'snapshot'})});
  assert.equal(read.status,200);assert.deepEqual(h.calls,[['snapshot','marktone',{role:'learner'}]]);
});

test('invitation tokens become hashes before the database and stay out of URL queries',async()=>{
  const h=route(),token='e4'.repeat(32);
  const input={tenantSlug:'marktone',commandId,payload:{studentId:commandId,invitationToken:token,tokenHash:'attacker-controlled',subjectId:commandId,role:'manager'}};
  const result=await h.POST(req(input),{params:Promise.resolve({action:'issue_invitation'})});
  assert.equal(result.status,200);assert.equal(h.calls.length,1);
  const [name,args]=h.calls[0];assert.equal(name,'v1_training_learning_action');
  assert.equal(args.p_payload.tokenHash,createHash('sha256').update(token).digest('hex'));
  assert.equal(args.p_payload.invitationToken,undefined);assert.equal(args.p_payload.role,undefined);assert.equal(args.p_payload.subjectId,undefined);
  assert.equal(JSON.stringify(args).includes(token),false);
  assert.equal(result.body.invitationUrl,`/training/accept#${token}`);
});

test('finance commands preserve UUID idempotency key and never honor client tenant or actor overrides',async()=>{
  const h=route();await h.POST(req({tenantSlug:'marktone',commandId,payload:{commandId:'override',tenantId:'reef',actorSubjectId:commandId,invoiceId:commandId}}),{params:Promise.resolve({action:'configure_finance'})});
  assert.deepEqual(h.calls,[['v1_tenant_training_journey_action',{p_slug:'marktone',p_action:'configure_finance',p_payload:{invoiceId:commandId,commandId}}]]);
});

test('instructor assignment retains validated target subject without accepting a client actor',async()=>{
  const h=route();const target='2c062758-4fe6-47eb-92a6-3a35f33cb37a';
  const result=await h.POST(req({tenantSlug:'marktone',commandId,payload:{runId:commandId,subjectId:target,actorSubjectId:target,active:true}}),{params:Promise.resolve({action:'assign_instructor'})});
  assert.equal(result.status,200);assert.equal(h.calls[0][1].p_payload.subjectId,target);assert.equal(h.calls[0][1].p_payload.actorSubjectId,undefined);
  const denied=route();assert.equal((await denied.POST(req({tenantSlug:'marktone',commandId,payload:{subjectId:'bad'}}),{params:Promise.resolve({action:'assign_instructor'})})).status,400);assert.equal(denied.calls.length,0);
});

test('learner/instructor snapshots never fetch staff finance data; invalid roles and IDs fail before RPC',async()=>{
  const calls=[];
  const {getTrainingSnapshot}=harness('lib/training-snapshot.js',{
    '/training-request.mjs':policy,'/training-server':{trainingRpc:async(name,args)=>{calls.push([name,args]);return {viewer:{},enrollments:[]};}}
  });
  for(const role of ['learner','instructor']){
    calls.length=0;await getTrainingSnapshot('marktone',{role});
    assert.equal(calls.length,1);assert.equal(calls[0][0],'v1_training_learning_snapshot');assert.equal(calls[0][1].p_role,role);
  }
  calls.length=0;
  for(const options of [{role:'admin'},{offset:-1},{offset:1.3},{offset:100001},{enrollmentId:'anything'}])await assert.rejects(getTrainingSnapshot('marktone',options));
  await assert.rejects(getTrainingSnapshot('reefskills',{role:'manager'}));assert.equal(calls.length,0);
});

test('disabled operational rollout returns its real disabled state without demo hydration or learning reads',async()=>{
  const calls=[];
  const {getTrainingSnapshot}=harness('lib/training-snapshot.js',{
    '/training-request.mjs':policy,'/training-server':{trainingRpc:async(name)=>{calls.push(name);return {enabled:false,settings:{timezone:'Asia/Riyadh'},capabilities:{canManage:true}};}}
  });
  const snapshot=await getTrainingSnapshot('marktone',{role:'manager'});
  assert.equal(snapshot.operations.enabled,false);assert.equal(snapshot.learning,null);
  assert.deepEqual(calls,['v1_tenant_training_journey_snapshot']);
});

test('training proxy refreshes learner sessions but leaves login/invitation landing public',async()=>{
  const {proxy,config}=harness('proxy.js',{
    'next/server':{NextResponse:{next:()=>({next:true}),json:(body,opts)=>({body,...opts}),redirect:url=>({redirect:url.href})}},
    './lib/config':{ACCESS_COOKIE:'access',REFRESH_COOKIE:'refresh',SUPABASE_URL:'https://example.invalid',SUPABASE_KEY:'public'}
  });
  const request=path=>({nextUrl:{pathname:path,search:'',clone:()=>new URL(`https://odeir.com${path}`)},cookies:{get:()=>undefined}});
  assert.ok(config.matcher.includes('/training/marktone/:path*'));
  assert.deepEqual(await proxy(request('/training/login')),{next:true});
  assert.deepEqual(await proxy(request('/training/accept')),{next:true});
  assert.match((await proxy(request('/training/marktone'))).redirect,/\/training\/login\?/);
  assert.equal((await proxy(request('/api/training/snapshot'))).status,401);
  assert.equal((await proxy(request('/api/training-auth/accept'))).status,401);
});
