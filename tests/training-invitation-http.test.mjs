import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as requestHelpers from '../lib/training-request.mjs';

const TOKEN='a'.repeat(64);
const TOKEN_HASH=createHash('sha256').update(TOKEN).digest('hex');
const CLAIM='9248d7a2-ad43-4368-8739-fb346d804f9b';
const PASSWORD='A safe test password 2026';
const SESSION={access_token:'test-learner-access',refresh_token:'test-learner-refresh',expires_in:3600};
const SUPABASE='https://training-test.invalid';
const PUBLIC='public-test-key',SERVICE='service-test-key';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

function compile(path,context,require=()=>{throw Error('Unexpected import');}){
  const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}
  }).outputText;
  const exports={};
  vm.runInContext(`(function(require,module,exports){${code}\n})`,context,{filename:path})(require,{exports},exports);
  return exports;
}

function edgeHarness(steps,env={SUPABASE_URL:SUPABASE,SUPABASE_ANON_KEY:PUBLIC,SUPABASE_SERVICE_ROLE_KEY:SERVICE}){
  const calls=[];let handler;
  const context=vm.createContext({
    Request,Response,Headers,TextEncoder,TextDecoder,Uint8Array,AbortSignal,crypto:webcrypto,
    Deno:{env:{get:key=>env[key]},serve:fn=>{handler=fn;}},
    fetch:async(url,init)=>{
      calls.push({url,method:init.method,headers:init.headers,body:JSON.parse(init.body)});
      const step=steps[calls.length-1];
      assert.ok(step,'Unexpected upstream request');
      assert.equal(new URL(url).pathname,step.path);
      if(step.error)throw step.error;
      return json(step.data,step.status||200);
    }
  });
  compile('supabase/functions/training-invitation-activation/index.ts',context);
  return {calls,request:(body={token:TOKEN,password:PASSWORD,claimId:CLAIM},init={})=>handler(new Request('https://edge.invalid/activate',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),...init
  }))};
}

const claimStep={path:'/rest/v1/rpc/v1_training_invitation_activation',data:{email:' Learner@Example.test ',tenantSlug:'marktone',fullName:'متدرب تجريبي'}};
const createStep={path:'/auth/v1/admin/users',data:{id:'auth-new-user'}};
const signStep={path:'/auth/v1/token',data:SESSION};
const acceptStep={path:'/rest/v1/rpc/v1_training_learning_action',data:{accepted:true}};
const releaseStep={path:'/rest/v1/rpc/v1_training_invitation_activation',data:{released:true}};

test('invitation edge validates request and configured secrets before any upstream call',async()=>{
  for(const [body,init,status] of [
    [{token:'bad',password:PASSWORD,claimId:CLAIM},{},400],
    [{token:TOKEN,password:PASSWORD,claimId:'not-a-uuid'},{},400],
    [{token:TOKEN,password:'short',claimId:CLAIM},{},400],
    [{token:TOKEN,password:'x'.repeat(257),claimId:CLAIM},{},400],
    [null,{method:'GET',body:undefined},405],
    [{token:TOKEN,password:PASSWORD,claimId:CLAIM},{headers:{'content-type':'text/plain'}},415],
    [{token:TOKEN,password:PASSWORD,claimId:CLAIM,extra:'x'.repeat(9000)},{},503]
  ]){
    const h=edgeHarness([]),response=await h.request(body,init);
    assert.equal(response.status,status);assert.equal(h.calls.length,0);
  }
  const h=edgeHarness([],{}),response=await h.request();
  assert.equal(response.status,503);assert.equal(h.calls.length,0);
});

test('new learner activation claims hashed token, creates only new Auth account and accepts with real learner JWT',async()=>{
  const h=edgeHarness([claimStep,createStep,signStep,acceptStep]);
  const response=await h.request(),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(body,{success:true,session:SESSION});
  assert.deepEqual(h.calls[0].body,{p_token_hash:TOKEN_HASH,p_claim_id:CLAIM,p_action:'claim'});
  assert.equal(h.calls[0].headers.authorization,`Bearer ${SERVICE}`);
  assert.deepEqual(h.calls[1].body,{email:'learner@example.test',password:PASSWORD,email_confirm:true,user_metadata:{full_name:'متدرب تجريبي'}});
  assert.equal(h.calls[1].method,'POST');
  assert.equal(h.calls[2].headers.apikey,PUBLIC);
  assert.equal(h.calls[2].headers.authorization,undefined);
  assert.deepEqual(h.calls[3].body,{p_tenant_slug:'marktone',p_action:'accept_invitation',p_command_id:CLAIM,p_payload:{tokenHash:TOKEN_HASH}});
  assert.equal(h.calls[3].headers.authorization,`Bearer ${SESSION.access_token}`);
  assert.equal(h.calls[3].headers.apikey,PUBLIC);
  assert.equal(h.calls.some(call=>JSON.stringify(call.body).includes('membership')),false);
  assert.equal(JSON.stringify(body).includes(PASSWORD),false);
  assert.equal(JSON.stringify(body).includes(SERVICE),false);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('invalid, revoked, disabled or leased invitation claim stops before Auth account creation',async()=>{
  for(const code of ['invalid_invitation','invitation_expired','invitation_busy','training_journey_disabled']){
    const h=edgeHarness([{...claimStep,status:400,data:{message:code}}]);
    const response=await h.request();
    assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'invalid_invitation'});
    assert.equal(h.calls.length,1);
  }
});

test('unrelated tenant claim is rejected and released without creating an account',async()=>{
  const h=edgeHarness([{...claimStep,data:{...claimStep.data,tenantSlug:'reefskills'}},releaseStep]);
  const response=await h.request();
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'activation_failed'});
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.p_action,'release');
});

test('existing Auth email never causes password reset, user update or service-role acceptance',async()=>{
  const h=edgeHarness([claimStep,{...createStep,status:422,data:{code:'email_exists',message:'private upstream identity'}},releaseStep]);
  const response=await h.request();
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'account_already_exists'});
  assert.equal(h.calls.length,3);assert.equal(h.calls.at(-1).body.p_action,'release');
  assert.ok(h.calls.every(call=>call.method==='POST'));
  assert.equal(h.calls.some(call=>call.url.includes('/auth/v1/token')),false);
});

test('created account with failed sign-in can use existing-account recovery without leaked credentials',async()=>{
  const h=edgeHarness([claimStep,createStep,{...signStep,status:400,data:{error:'some auth error'}},releaseStep]);
  const response=await h.request();
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'account_already_exists'});
  assert.equal(h.calls.at(-1).body.p_action,'release');
});

test('acceptance revoked in flight returns no session and releases activation lease',async()=>{
  const h=edgeHarness([claimStep,createStep,signStep,{...acceptStep,status:403,data:{message:'training_journey_disabled'}},releaseStep]);
  const response=await h.request();
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'activation_failed'});
  assert.equal(h.calls.at(-1).body.p_action,'release');
});

test('upstream account-creation timeout releases its claim and never returns upstream exception text',async()=>{
  const h=edgeHarness([claimStep,{...createStep,error:Error(`sensitive ${PASSWORD} ${SERVICE}`)},releaseStep]);
  const response=await h.request();
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'activation_failed'});
  assert.equal(h.calls.at(-1).body.p_action,'release');
});

function authRouteHarness({upstream=[],rpcResult={ok:true},rpcError=null,cookieToken=null}={}){
  const calls=[],rpcCalls=[],cookieWrites=[];
  const context=vm.createContext({
    Request,Response,Headers,AbortSignal,Buffer,process:{env:{NODE_ENV:'production'}},
    fetch:async(url,init)=>{calls.push({url,headers:init.headers,body:JSON.parse(init.body)});const step=upstream[calls.length-1];assert.ok(step,'Unexpected Auth call');return json(step.data,step.status||200);}
  });
  const cookieStore={get:key=>key==='mt_access'&&cookieToken?{value:cookieToken}:undefined};
  const response=(body,status=200)=>{const r=json(body,status);r.cookies={set:(...args)=>cookieWrites.push(args)};return r;};
  const mod=compile('app/api/training-auth/[action]/route.js',context,name=>{
    if(name==='node:crypto')return {createHash};
    if(name==='next/headers')return {cookies:async()=>cookieStore};
    if(name.endsWith('/config'))return {ACCESS_COOKIE:'mt_access',REFRESH_COOKIE:'mt_refresh',SUPABASE_KEY:PUBLIC,SUPABASE_URL:SUPABASE};
    if(name.endsWith('/training-request.mjs'))return requestHelpers;
    if(name.endsWith('/training-server'))return {
      trainingJson:response,trainingFailure:error=>response({error:error.code},error.status||503),
      trainingRpc:async(...args)=>{rpcCalls.push(JSON.parse(JSON.stringify(args)));if(rpcError)throw rpcError;return rpcResult;}
    };
    throw Error(`Unexpected import ${name}`);
  });
  return {calls,rpcCalls,cookieWrites,request:(action,body,origin='https://odeir.com')=>mod.POST(new Request(`https://odeir.com/api/training-auth/${action}`,{
    method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)
  }),{params:Promise.resolve({action})})};
}

test('Auth route checks same-origin before password or activation calls',async()=>{
  const h=authRouteHarness(),response=await h.request('login',{email:'learner@example.test',password:PASSWORD},'https://evil.example');
  assert.equal(response.status,403);assert.equal(h.calls.length,0);assert.equal(h.rpcCalls.length,0);assert.equal(h.cookieWrites.length,0);
});

test('existing learner login validates learner snapshot before setting shared secure session cookies',async()=>{
  const h=authRouteHarness({upstream:[{data:SESSION}]}),response=await h.request('login',{email:' Learner@Example.test ',password:PASSWORD});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,next:'/training/marktone'});
  assert.equal(h.rpcCalls.length,1);
  assert.deepEqual(h.rpcCalls[0],['v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'learner'},{token:SESSION.access_token}]);
  assert.equal(h.cookieWrites.length,2);
  for(const [,token,options] of h.cookieWrites){assert.ok(Object.values(SESSION).includes(token));assert.equal(options.httpOnly,true);assert.equal(options.secure,true);assert.equal(options.sameSite,'lax');}
});

test('employee credentials cannot receive training session without learner authorization',async()=>{
  const h=authRouteHarness({upstream:[{data:SESSION}],rpcError:requestHelpers.trainingProblem('forbidden',403)});
  const response=await h.request('login',{email:'employee@example.test',password:PASSWORD});
  assert.equal(response.status,403);assert.equal(h.cookieWrites.length,0);
});

test('instructor login authorizes exactly the instructor snapshot and returns a fixed role-aware destination',async()=>{
  const h=authRouteHarness({upstream:[{data:SESSION}]});
  const response=await h.request('login',{email:'instructor@example.test',password:PASSWORD,role:'instructor',next:'https://evil.example/steal'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{success:true,next:'/training/marktone?role=instructor'});
  assert.deepEqual(h.rpcCalls,[['v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'instructor'},{token:SESSION.access_token}]]);
  assert.equal(h.cookieWrites.length,2);
});

test('denied instructor login cannot silently fall back to a learner snapshot or establish a session',async()=>{
  const h=authRouteHarness({upstream:[{data:SESSION}],rpcError:requestHelpers.trainingProblem('forbidden',403)});
  const response=await h.request('login',{email:'instructor@example.test',password:PASSWORD,role:'instructor'});
  assert.equal(response.status,403);
  assert.deepEqual(h.rpcCalls,[['v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'instructor'},{token:SESSION.access_token}]]);
  assert.equal(h.cookieWrites.length,0);
});

test('unsupported login roles are rejected before password grants or authorization calls',async()=>{
  for(const role of ['manager','admin','platform_owner','Instructor','instructor&role=manager',{},['instructor'],true]){
    const h=authRouteHarness();
    const response=await h.request('login',{email:'instructor@example.test',password:PASSWORD,role});
    assert.equal(response.status,400,JSON.stringify(role));
    assert.equal(h.calls.length,0);assert.equal(h.rpcCalls.length,0);assert.equal(h.cookieWrites.length,0);
  }
});

test('learner invitations cannot be promoted to instructor through register, login or accept',async()=>{
  for(const action of ['register','login','accept']){
    const h=authRouteHarness({cookieToken:'real-authenticated-user'});
    const response=await h.request(action,{email:'instructor@example.test',password:PASSWORD,token:TOKEN,commandId:CLAIM,role:'instructor'});
    assert.equal(response.status,400,action);
    assert.equal(h.calls.length,0);assert.equal(h.rpcCalls.length,0);assert.equal(h.cookieWrites.length,0);
  }
});

test('authenticated invitation acceptance hashes bearer token and does not change session identity',async()=>{
  const h=authRouteHarness({cookieToken:'real-authenticated-user'});
  const response=await h.request('accept',{token:TOKEN,commandId:CLAIM});
  assert.equal(response.status,200);assert.equal(h.calls.length,0);assert.equal(h.cookieWrites.length,0);
  assert.deepEqual(h.rpcCalls[0],['v1_training_learning_action',{p_tenant_slug:'marktone',p_action:'accept_invitation',p_command_id:CLAIM,p_payload:{tokenHash:TOKEN_HASH}},{token:'real-authenticated-user'}]);
});

test('registration only returns navigation JSON and transfers edge session into HttpOnly cookies',async()=>{
  const h=authRouteHarness({upstream:[{data:{success:true,session:SESSION}}]});
  const response=await h.request('register',{token:TOKEN,commandId:CLAIM,password:PASSWORD});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,next:'/training/marktone'});
  assert.equal(h.cookieWrites.length,2);assert.equal(h.rpcCalls.length,0);
});
