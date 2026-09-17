import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const load=(name,fetch)=>{
 let handler;
 const source=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 vm.runInNewContext(code,{Request,Response,AbortSignal,fetch,Deno:{env:{get:k=>({SUPABASE_URL:'https://db.test',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'service-test'})[k]},serve:h=>{handler=h;}}});
 return handler;
};
const response=(data,status=200)=>Response.json(data,{status});
const call=(handler,body,auth='Bearer user-test')=>handler(new Request('https://edge.test',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body)}));
const payload={p_tenant_slug:'existing',p_staff_id:'00000000-0000-4000-8000-000000000020',password:' TempPassword123! '};
const prepared={operationId:'operation-1',email:'staff@example.test',fullName:'Staff',authUserExists:false};

test('direct activation authorizes first, creates exact identity, and never exposes password/session',async()=>{
 const calls=[];
 const handler=load('tenant-staff-account',async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,body,headers:init.headers});
  if(url.endsWith('v1_tenant_prepare_staff_account'))return response(prepared);
  if(url.endsWith('/auth/v1/admin/users'))return response({id:'user-created'});
  return response({completed:true,mustChangePassword:true});
 });
 const result=await call(handler,{...payload,email:'attacker@test',role:'tenant_owner',authUserId:'other'});
 assert.equal(result.status,200);assert.equal(calls.length,3);
 assert.equal(calls[0].headers.authorization,'Bearer user-test');
 assert.deepEqual(calls[0].body,{p_tenant_slug:'existing',p_staff_id:payload.p_staff_id});
 assert.equal(calls[1].body.email,prepared.email);assert.equal(calls[1].body.password,payload.password);
 assert.equal(calls[1].body.app_metadata.staff_activation_id,prepared.operationId);
 assert.equal(calls[2].headers.authorization,'Bearer user-test');
 const text=await result.text();assert.ok(!text.includes(payload.password));assert.ok(!text.includes('service-test'));
});

test('capacity/authorization failure and missing JWT cannot create Auth users',async()=>{
 let calls=0;const handler=load('tenant-staff-account',async()=>{calls++;return response({message:'plan_limit_reached'},400);});
 assert.equal((await call(handler,payload,'')).status,401);assert.equal(calls,0);
 const result=await call(handler,payload);assert.equal((await result.json()).error,'plan_limit_reached');assert.equal(calls,1);
});

test('partial creation resumes without replacing the existing password',async()=>{
 const urls=[];const handler=load('tenant-staff-account',async(url)=>{
  urls.push(url);return response(url.endsWith('v1_tenant_prepare_staff_account')?{...prepared,authUserExists:true}:{completed:true});
 });
 const result=await call(handler,payload);assert.equal((await result.json()).data.passwordUnchanged,true);
 assert.equal(urls.some(url=>url.includes('/auth/')),false);
});

test('invitation capacity preflight stops account creation',async()=>{
 const urls=[];const handler=load('tenant-invitation-activation',async(url)=>{urls.push(url);return response({message:'plan_limit_reached'},400);});
 const result=await call(handler,{token:'a'.repeat(64),password:'password-123456'});
 assert.equal((await result.json()).error,'plan_limit_reached');assert.equal(urls.length,1);
 assert.match(urls[0],/v1_invitation_activation_preflight/);
});

test('already-created invitation account resumes only with its actual password, without resetting it',async()=>{
 const calls=[];let passwordCorrect=false;
 const handler=load('tenant-invitation-activation',async(url,init)=>{
  calls.push({url,method:init.method,body:JSON.parse(init.body)});
  if(url.endsWith('v1_invitation_activation_preflight'))return response({email:'staff@example.test'});
  if(url.endsWith('v1_invitation_auth_user'))return response({id:'staff-auth-id',email_confirmed_at:'2026-01-01'});
  if(url.includes('grant_type=password'))return passwordCorrect?response({access_token:'user-jwt',refresh_token:'refresh'}):response({error:'invalid_credentials'},400);
  if(url.endsWith('v2_accept_tenant_invitation'))return response({tenantSlug:'existing'});
  throw new Error('Unexpected privileged mutation');
 });
 const body={token:'b'.repeat(64),password:' ExactPassword123 '};
 const denied=await call(handler,body);assert.equal((await denied.json()).error,'account_already_exists');
 passwordCorrect=true;const accepted=await call(handler,body);assert.equal((await accepted.json()).success,true);
 assert.equal(calls.some(c=>c.url.includes('/admin/users')),false);
 assert.equal(calls.find(c=>c.url.includes('grant_type=password')).body.password,body.password);
});
