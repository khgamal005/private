import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as requestHelpers from '../lib/training-request.mjs';
import * as academyPolicy from '../lib/academy-policy.mjs';
import * as academyNavigation from '../lib/academy-navigation.mjs';
import * as recoveryHelpers from '../lib/password-recovery.mjs';

const TOKEN='b'.repeat(64);
const HASH=createHash('sha256').update(TOKEN).digest('hex');
const PASSWORD='A safe password for academy';
const SESSION={access_token:'recipient-access-token',refresh_token:'recipient-refresh-token',expires_in:9000};
const PREVIEW={tenantId:'tenant-marktone',slug:'marktone',email:' Invited@Example.test ',role:'manager'};
const ACCEPTED={tenantId:'tenant-marktone',slug:'marktone',role:'manager'};
const INVITE={tenantSlug:'marktone',token:TOKEN,email:'invited@example.test'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

function harness({auth=[],preview=PREVIEW,accepted=ACCEPTED,rpcError=null,cookieToken=null}={}){
  const authCalls=[],rpcCalls=[],writes=[],events=[];
  const response=(body,status=200)=>{const value=json(body,status);value.cookies={set:(...args)=>{events.push('cookie');writes.push(args);}};return value;};
  const context=vm.createContext({
    Request,Response,Headers,AbortSignal,Buffer,URL,process:{env:{NODE_ENV:'production'}},
    fetch:async(url,init)=>{
      events.push('auth');authCalls.push({url,headers:init.headers,body:JSON.parse(init.body),cache:init.cache,redirect:init.redirect});
      const step=auth[authCalls.length-1];assert.ok(step,'Unexpected Auth request');
      if(step.error)throw step.error;
      return json(step.data,step.status||200);
    }
  });
  const code=ts.transpileModule(readFileSync(new URL('../app/api/academy-invitations/[action]/route.js',import.meta.url),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}
  }).outputText;
  const exports={};
  const require=name=>{
    if(name==='node:crypto')return {createHash};
    if(name==='next/headers')return {cookies:async()=>({get:key=>key==='mt_access'&&cookieToken?{value:cookieToken}:undefined})};
    if(name.endsWith('/config'))return {ACCESS_COOKIE:'mt_access',REFRESH_COOKIE:'mt_refresh',SUPABASE_KEY:'public-key',SUPABASE_URL:'https://supabase.invalid'};
    if(name.endsWith('/academy-policy.mjs'))return academyPolicy;
    if(name.endsWith('/academy-navigation.mjs'))return academyNavigation;
    if(name.endsWith('/password-recovery.mjs'))return recoveryHelpers;
    if(name.endsWith('/training-request.mjs'))return requestHelpers;
    if(name.endsWith('/training-server'))return {
      trainingJson:response,trainingFailure:error=>response({error:error.code||'request_failed'},error.status||503),
      trainingRpc:async(...args)=>{
        events.push(args[0]);rpcCalls.push(JSON.parse(JSON.stringify(args)));
        if(rpcError?.name===args[0])throw requestHelpers.trainingProblem(rpcError.code,rpcError.status);
        if(args[0]==='v1_academy_invitation_preview')return preview;
        if(args[0]==='v1_academy_membership_accept')return accepted;
        throw Error('Unexpected RPC');
      }
    };
    throw Error(`Unexpected import ${name}`);
  };
  vm.runInContext(`(function(require,module,exports){${code}\n})`,context)(require,{exports},exports);
  return {authCalls,rpcCalls,writes,events,request:(action,body=INVITE,headers={})=>exports.POST(new Request(`https://odeir.com/api/academy-invitations/${action}`,{
    method:'POST',headers:{origin:'https://odeir.com','content-type':'application/json','sec-fetch-site':'same-origin',...headers},body:JSON.stringify(body)
  }),{params:Promise.resolve({action})})};
}

test('academy invitation requests reject foreign origins, oversized bodies and malformed capabilities before upstream calls',async()=>{
  for(const [body,headers,status] of [
    [INVITE,{origin:'https://attacker.invalid'},403],
    [INVITE,{'content-type':'text/plain'},415],
    [{...INVITE,unused:'a'.repeat(9000)},{},413],
    [{...INVITE,token:'not-a-token'},{},400],
    [{...INVITE,tenantSlug:'//attacker.invalid'},{},400]
  ]){
    const h=harness(),r=await h.request('preview',body,headers);
    assert.equal(r.status,status);assert.equal(h.authCalls.length,0);assert.equal(h.rpcCalls.length,0);assert.equal(h.writes.length,0);
  }
});

test('public preview forwards only tenant slug and hashed token, returns minimum data and never touches Auth or session',async()=>{
  const h=harness(),r=await h.request('preview');
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{email:'invited@example.test',role:'manager'});
  assert.deepEqual(h.rpcCalls,[['v1_academy_invitation_preview',{p_slug:'marktone',p_token_hash:HASH},{publicAccess:true}]]);
  assert.equal(h.authCalls.length,0);assert.equal(h.writes.length,0);assert.equal(JSON.stringify(h.rpcCalls).includes(TOKEN),false);
});

test('invalid, disabled, expired or mismatched preview prevents account creation',async()=>{
  for(const code of ['academy_invitation_invalid','academy_disabled','academy_account_inactive']){
    const h=harness({rpcError:{name:'v1_academy_invitation_preview',code,status:403}});
    const r=await h.request('register',{...INVITE,password:PASSWORD});
    assert.equal(r.status,403);assert.equal(h.authCalls.length,0);assert.equal(h.writes.length,0);
  }
  const h=harness({preview:{...PREVIEW,slug:'unrelated'}}),r=await h.request('register',{...INVITE,password:PASSWORD});
  assert.equal(r.status,400);assert.equal(h.authCalls.length,0);
});

test('login accepts a real authenticated bearer before secure cookies, ignoring injected role, ID and redirect',async()=>{
  const h=harness({auth:[{data:SESSION}],cookieToken:'old-staff-token'});
  const r=await h.request('login',{...INVITE,password:PASSWORD,email:' Invited@Example.test ',role:'owner',tenantId:'reef',next:'https://attacker.invalid'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{success:true,next:'/academy/marktone'});
  assert.deepEqual(h.authCalls[0].body,{email:'invited@example.test',password:PASSWORD});
  assert.equal(h.authCalls[0].url,'https://supabase.invalid/auth/v1/token?grant_type=password');
  assert.equal(h.authCalls[0].headers.apikey,'public-key');assert.equal(h.authCalls[0].headers.Authorization,undefined);
  assert.equal(h.authCalls[0].cache,'no-store');assert.equal(h.authCalls[0].redirect,'error');
  assert.deepEqual(h.rpcCalls[0],['v1_academy_membership_accept',{p_slug:'marktone',p_token_hash:HASH},{token:SESSION.access_token}]);
  assert.deepEqual(h.events,['auth','v1_academy_membership_accept','cookie','cookie']);
  for(const [,token,options] of h.writes){assert.ok(Object.values(SESSION).includes(token));assert.equal(options.httpOnly,true);assert.equal(options.secure,true);assert.equal(options.sameSite,'lax');assert.equal(options.path,'/');}
  assert.equal(h.writes[0][2].maxAge,3600);
});

test('instructor invitation goes to instructor training, without accepting a client-selected management role',async()=>{
  const h=harness({auth:[{data:SESSION}],preview:{...PREVIEW,role:'instructor'},accepted:{...ACCEPTED,role:'instructor'}});
  const r=await h.request('login',{...INVITE,password:PASSWORD,role:'manager'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{success:true,next:'/training/marktone?workspace=academy&role=instructor'});
});

test('failed password grant cannot fall back to a current employee cookie',async()=>{
  const h=harness({auth:[{status:400,data:{code:'invalid_credentials',message:'sensitive upstream details'}}],cookieToken:'employee-token'});
  const r=await h.request('login',{...INVITE,password:PASSWORD});
  assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'invalid_credentials'});assert.equal(h.rpcCalls.length,0);assert.equal(h.writes.length,0);
});

test('revoked invitation, wrong or unconfirmed email and inactive account never commit a successful Auth session',async()=>{
  for(const code of ['academy_invitation_invalid','authentication_required','academy_account_inactive']){
    const h=harness({auth:[{data:SESSION}],rpcError:{name:'v1_academy_membership_accept',code,status:403}});
    const r=await h.request('login',{...INVITE,password:PASSWORD});
    assert.equal(r.status,403);assert.equal(h.writes.length,0);assert.equal(h.rpcCalls.length,1);
  }
});

test('registration derives email from invitation and leaves acceptance pending until email confirmation',async()=>{
  const h=harness({auth:[{data:{user:{id:'new-user',identities:[{id:'identity'}]},session:null}}]});
  const r=await h.request('register',{...INVITE,password:PASSWORD,email:'forged@example.test',role:'owner'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{success:true,confirmationRequired:true});
  assert.equal(new URL(h.authCalls[0].url).pathname,'/auth/v1/signup');
  assert.equal(new URL(h.authCalls[0].url).searchParams.get('redirect_to'),'https://odeir.com/academy/confirmed?tenant=marktone');
  assert.deepEqual(h.authCalls[0].body,{email:'invited@example.test',password:PASSWORD});
  assert.equal(h.rpcCalls.length,1);assert.equal(h.writes.length,0);
  assert.equal(JSON.stringify(h.authCalls).includes('email_confirm'),false);
});

test('immediately confirmed signup still requires authenticated membership acceptance before session cookies',async()=>{
  const h=harness({auth:[{data:{...SESSION,user:{id:'new-user',email_confirmed_at:'2026-09-22'}}}]});
  const r=await h.request('register',{...INVITE,password:PASSWORD});
  assert.equal(r.status,200);assert.equal(h.rpcCalls.length,2);assert.equal(h.writes.length,2);
  assert.deepEqual(h.events,['v1_academy_invitation_preview','auth','v1_academy_membership_accept','cookie','cookie']);
});

test('existing signup identity returns login guidance without resetting password or changing existing session',async()=>{
  for(const reply of [
    {status:422,data:{code:'user_already_exists'}},
    {data:{user:{id:'obfuscated-user',identities:[]}}},
    {data:{id:'obfuscated-user',identities:[]}}
  ]){
    const h=harness({auth:[reply],cookieToken:'old-session'}),r=await h.request('register',{...INVITE,password:PASSWORD});
    assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'account_already_exists'});
    assert.equal(h.authCalls.length,1);assert.equal(h.rpcCalls.length,1);assert.equal(h.writes.length,0);
  }
});

test('authenticated acceptance uses the current bearer and cannot replace identity or elevate through request fields',async()=>{
  const h=harness({cookieToken:'confirmed-recipient'}),r=await h.request('accept',{...INVITE,role:'owner',email:'forged@example.test'});
  assert.equal(r.status,200);assert.equal(h.authCalls.length,0);assert.equal(h.writes.length,0);
  assert.deepEqual(h.rpcCalls[0],['v1_academy_membership_accept',{p_slug:'marktone',p_token_hash:HASH},{token:'confirmed-recipient'}]);
  const anonymous=harness(),denied=await anonymous.request('accept');assert.equal(denied.status,401);assert.equal(anonymous.rpcCalls.length,0);
});

test('wrong tenant response or malformed session cannot establish cookies or redirect',async()=>{
  const h=harness({auth:[{data:SESSION}],accepted:{...ACCEPTED,slug:'another-tenant'}});
  const r=await h.request('login',{...INVITE,password:PASSWORD});assert.equal(r.status,400);assert.equal(h.writes.length,0);
  const malformed=harness({auth:[{data:{access_token:'token-without-refresh'}}]});
  const denied=await malformed.request('login',{...INVITE,password:PASSWORD});assert.equal(denied.status,503);assert.equal(malformed.rpcCalls.length,0);assert.equal(malformed.writes.length,0);
});

test('login and acceptance retry reach the idempotent RPC even after public preview is no longer available',async()=>{
  for(const action of ['login','accept']){
    const h=harness({auth:[{data:SESSION}],cookieToken:'confirmed-recipient',rpcError:{name:'v1_academy_invitation_preview',code:'academy_invitation_invalid',status:409}});
    const r=await h.request(action,{...INVITE,password:PASSWORD});
    assert.equal(r.status,200);assert.equal(h.rpcCalls.length,1);assert.equal(h.rpcCalls[0][0],'v1_academy_membership_accept');
  }
});

test('a valid password for a different email cannot receive a session when SQL rejects the invitation binding',async()=>{
  const h=harness({auth:[{data:SESSION}],rpcError:{name:'v1_academy_membership_accept',code:'academy_invitation_invalid',status:409}});
  const r=await h.request('login',{...INVITE,email:'attacker@example.test',password:PASSWORD});
  assert.equal(r.status,409);assert.equal(h.writes.length,0);
  assert.deepEqual(h.authCalls[0].body,{email:'attacker@example.test',password:PASSWORD});
  assert.deepEqual(h.rpcCalls[0][1],{p_slug:'marktone',p_token_hash:HASH});
});

test('Auth timeout and rate limits return safe errors without exposing submitted credentials',async()=>{
  const h=harness({auth:[{error:Error(`private ${PASSWORD} ${TOKEN}`)}]});
  const r=await h.request('login',{...INVITE,password:PASSWORD});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'network_unavailable'});assert.equal(h.writes.length,0);
  const limited=harness({auth:[{status:429,data:{message:'private rate-limit response'}}]});
  const denied=await limited.request('login',{...INVITE,password:PASSWORD});assert.equal(denied.status,429);assert.equal(limited.writes.length,0);
});
