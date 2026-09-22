import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../lib/academy-policy.mjs';
import * as trainingPolicy from '../lib/training-request.mjs';
import * as recoveryPolicy from '../lib/password-recovery.mjs';
const require=createRequire(import.meta.url);
const access={enabled:true,tenant:{id:'3d185482-b916-49cc-b868-b6dfdb93eba8',slug:'marktone',name:'اسم حقيقي',timezone:'Africa/Cairo',currency:'EGP'},components:{lms:true,website:true,store:true},mode:'standalone',permissions:{manageLearning:true,manageWebsite:true},odeirAccess:false};
const session={access_token:'test-access',refresh_token:'test-refresh',expires_in:3600};
const commandId='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269';
function compile(path,stubs){
  const out=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,exports={};
  vm.runInThisContext(`(function(require,module,exports){${out}\n})`,{filename:path})(name=>{
    if(name.endsWith('/academy-policy.mjs'))return policy;
    if(name.endsWith('/training-request.mjs'))return trainingPolicy;
    if(name.endsWith('/password-recovery.mjs'))return recoveryPolicy;
    const key=Object.keys(stubs).find(key=>name.endsWith(key));return key?stubs[key]:require(name);
  },{exports},exports);return exports;
}
function request(path,body,origin='https://odeir.com'){return new Request('https://odeir.com'+path,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});}
function response(body,status=200){return {body,status,cookies:{writes:[],set(...args){this.writes.push(args);}}};}
function rpcHarness(path,handler){
  const calls=[];return {...compile(path,{'/config':{ACCESS_COOKIE:'access',REFRESH_COOKIE:'refresh',SUPABASE_URL:'https://auth.invalid',SUPABASE_KEY:'public'},'/training-server':{trainingJson:response,trainingFailure:error=>response({error:error.code},error.status||503),trainingRpc:async(name,args,options)=>{calls.push([name,args,options]);return handler(name,args,options);}},'/training-snapshot':{getTrainingSnapshot:async(...args)=>{calls.push(['snapshot',...args]);return {};}}}),calls};
}
test('academy access binds slug, entitlement, component and exact permission without trusting mode',()=>{
  assert.equal(policy.academyAccessAllowed(access,'marktone',{requiredComponent:'lms',permission:'manageLearning'}),true);
  for(const value of [{...access,enabled:false},{...access,tenant:{...access.tenant,slug:'reef'}},{...access,components:{lms:false}},{...access,permissions:{manageLearning:false}}])assert.equal(policy.academyAccessAllowed(value,'marktone',{requiredComponent:'lms',permission:'manageLearning'}),false);
  for(const slug of ['https://evil.test','../reef','%2fmarktone','MARKTONE','-bad'])assert.equal(policy.validAcademySlug(slug),false);
});
test('standalone manager snapshot uses only academy learning RPC and authoritative branding',async()=>{
  const h=rpcHarness('lib/training-snapshot.js',name=>name==='v1_academy_workspace_snapshot'?access:{courses:[],enrollments:[],tenant:access.tenant});
  const result=await h.getTrainingSnapshot('marktone',{workspace:'academy',role:'manager'});
  assert.equal(result.operations,null);assert.deepEqual(result.tenant,access.tenant);assert.equal(result.mode,'standalone');
  assert.deepEqual(h.calls.map(call=>call[0]),['v1_academy_workspace_snapshot','v1_academy_training_snapshot','v1_academy_request_snapshot']);
});
test('academy learner/instructor snapshots cannot query manager permissions or finance and reject substituted branding',async()=>{
  for(const role of ['learner','instructor']){
    const h=rpcHarness('lib/training-snapshot.js',()=>({role,tenant:access.tenant,courses:[],enrollments:[]}));
    const result=await h.getTrainingSnapshot('marktone',{workspace:'academy',role});assert.deepEqual(result.tenant,access.tenant);
    assert.deepEqual(h.calls.map(call=>call[0]),role==='learner'?['v1_academy_training_snapshot','v1_academy_learner_paths']:['v1_academy_training_snapshot']);assert.equal(h.calls[0][1].p_role,role);
  }
  const denied=rpcHarness('lib/training-snapshot.js',()=>({tenant:{...access.tenant,slug:'reef'}}));
  await assert.rejects(denied.getTrainingSnapshot('marktone',{workspace:'academy',role:'learner'}),error=>error.status===404);
});
test('academy manager training authorization precedes mutation; disabled access never writes',async()=>{
  for(const changed of [{...access,enabled:false},{...access,permissions:{manageLearning:false}},{...access,tenant:{...access.tenant,slug:'reef'}}]){
    const h=rpcHarness('app/api/training/[action]/route.js',()=>changed);
    const result=await h.POST(request('/api/training/save_draft',{tenantSlug:'marktone',workspace:'academy',commandId,payload:{role:'manager'}}),{params:Promise.resolve({action:'save_draft'})});
    assert.equal(result.status,403);assert.deepEqual(h.calls.map(call=>call[0]),['v1_academy_workspace_snapshot']);
  }
});
test('academy mutations strip actor/workspace overrides; learner requests use learner-only RPC',async()=>{
  const h=rpcHarness('app/api/training/[action]/route.js',name=>name==='v1_academy_workspace_snapshot'?access:{success:true});
  const result=await h.POST(request('/api/training/record_attendance',{tenantSlug:'marktone',workspace:'academy',commandId,payload:{role:'manager',workspace:'odeir',tenantId:'reef',actorSubjectId:'forged',enrollmentId:commandId}}),{params:Promise.resolve({action:'record_attendance'})});
  assert.equal(result.status,200);assert.equal(h.calls[0][0],'v1_academy_training_action');assert.deepEqual(h.calls[0][1].p_payload,{enrollmentId:commandId});
  h.calls.length=0;
  await h.POST(request('/api/training/create_request',{tenantSlug:'marktone',workspace:'academy',commandId,payload:{kind:'withdraw',enrollmentId:commandId}}),{params:Promise.resolve({action:'create_request'})});
  assert.equal(h.calls[0][0],'v1_academy_training_action');
});
test('payload workspace cannot opt a legacy snapshot into academy authorization',async()=>{
  const h=rpcHarness('app/api/training/[action]/route.js',()=>access);
  await h.POST(request('/api/training/snapshot',{tenantSlug:'marktone',payload:{role:'manager',workspace:'academy'}}),{params:Promise.resolve({action:'snapshot'})});
  assert.deepEqual(h.calls,[['snapshot','marktone',{role:'manager'}]]);
});
test('manager login never establishes cookies until exact tenant management authorization succeeds',async()=>{
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify(session),{status:200});
  try{
    for(const changed of [access,{...access,enabled:false},{...access,permissions:{}},{...access,tenant:{...access.tenant,slug:'reef'}}]){
      const h=rpcHarness('app/api/academy-auth/[action]/route.js',()=>changed);
      const result=await h.POST(request('/api/academy-auth/login',{tenantSlug:'marktone',email:'manager@example.test',password:'test-password'}),{params:Promise.resolve({action:'login'})});
      assert.equal(result.status,changed===access?200:403);assert.equal(result.cookies.writes.length,changed===access?2:0);
      if(changed===access){assert.equal(result.body.next,'/academy/marktone');assert.equal(h.calls[0][2].token,session.access_token);assert.ok(result.cookies.writes.every(([, ,options])=>options.httpOnly&&options.sameSite==='lax'));}
    }
  }finally{globalThis.fetch=oldFetch;}
});
test('cross-origin academy login and malformed slug never call password provider',async()=>{
  const oldFetch=globalThis.fetch;let count=0;globalThis.fetch=async()=>{count++;throw Error('must not fetch');};
  try{
    const h=rpcHarness('app/api/academy-auth/[action]/route.js',()=>access);
    for(const [slug,origin] of [['marktone','https://attacker.test'],['../reef','https://odeir.com']]){
      const result=await h.POST(request('/api/academy-auth/login',{tenantSlug:slug,email:'manager@example.test',password:'test'},origin),{params:Promise.resolve({action:'login'})});assert.ok([400,403].includes(result.status));
    }
    assert.equal(count,0);assert.equal(h.calls.length,0);
  }finally{globalThis.fetch=oldFetch;}
});
test('recovery destination is restricted to known login routes and preserves training role',()=>{
  assert.equal(policy.recoveryLoginPath({workspace:'academy',tenantSlug:'marktone'}),'/academy/login?tenant=marktone');
  assert.equal(policy.recoveryLoginPath({workspace:'training',tenantSlug:'marktone',role:'instructor'}),'/training/login?tenant=marktone&workspace=academy&role=instructor');
  assert.equal(policy.recoveryLoginPath({workspace:'https://evil.test',tenantSlug:'marktone'}),'/login');
  assert.equal(policy.recoveryLoginPath({workspace:'academy',tenantSlug:'//evil.test'}),'/login');
});


test('connected admissions-only staff read operations without learning content; standalone staff cannot query Odeir',async()=>{
  const connected={...access,mode:'connected',odeirAccess:true,permissions:{manageLearning:false,manageAdmissions:true}};
  const h=rpcHarness('lib/training-snapshot.js',name=>name==='v1_academy_workspace_snapshot'?connected:{enabled:true,capabilities:{canManage:true}});
  const result=await h.getTrainingSnapshot('marktone',{workspace:'academy',role:'manager'});
  assert.equal(result.learning,null);assert.equal(result.viewer.canManageLearning,false);
  assert.deepEqual(h.calls.map(call=>call[0]),['v1_academy_workspace_snapshot','v1_tenant_training_journey_snapshot']);
  const standalone=rpcHarness('lib/training-snapshot.js',name=>name==='v1_academy_workspace_snapshot'?{...access,odeirAccess:true}:{tenant:access.tenant});
  const isolated=await standalone.getTrainingSnapshot('marktone',{workspace:'academy',role:'manager'});
  assert.equal(isolated.operations,null);assert.equal(standalone.calls.some(call=>call[0]==='v1_tenant_training_journey_snapshot'),false);
});


test('standalone admissions role reads scoped request queue without learning or Odeir operations',async()=>{
  const limited={...access,permissions:{manageAdmissions:true}};
  const queue={requests:[{id:commandId,studentName:'متدرب',courseTitle:'دورة',kind:'withdraw',status:'pending'}],runs:[],canManage:true,limit:50};
  const h=rpcHarness('lib/training-snapshot.js',name=>name==='v1_academy_workspace_snapshot'?limited:queue);
  const result=await h.getTrainingSnapshot('marktone',{workspace:'academy',role:'manager'});
  assert.equal(result.learning,null);assert.equal(result.operations,null);assert.equal(result.requestQueue.canManage,true);
  assert.deepEqual(h.calls.map(call=>call[0]),['v1_academy_workspace_snapshot','v1_academy_request_snapshot']);
});

test('standalone request endpoints cannot be reached through legacy workspace and strip staff/actor overrides',async()=>{
  const h=rpcHarness('app/api/training/[action]/route.js',()=>({success:true}));
  const action='academy_decide_request';
  const denied=await h.POST(request('/api/training/'+action,{tenantSlug:'marktone',commandId,payload:{}}),{params:Promise.resolve({action})});
  assert.equal(denied.status,400);assert.equal(h.calls.length,0);
  const accepted=await h.POST(request('/api/training/'+action,{tenantSlug:'marktone',workspace:'academy',commandId,payload:{requestId:commandId,decision:'reject',reason:'reason',role:'manager',actorSubjectId:commandId,assignedStaffId:commandId,dueAt:'2099-01-01'}}),{params:Promise.resolve({action})});
  assert.equal(accepted.status,200);assert.deepEqual(h.calls[0].slice(0,2),['v1_academy_request_action',{p_slug:'marktone',p_action:'decide_request',p_command_id:commandId,p_payload:{requestId:commandId,decision:'reject',reason:'reason'}}]);
});
