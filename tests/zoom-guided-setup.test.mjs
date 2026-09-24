import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {zoomSetup,call,login,service,T,OTHER,ADMIN,ADMIN_AUTH,LEARNER_AUTH,STAFF,id} from './fixtures/zoom-database.mjs';
import {createZoomHandler} from '../supabase/functions/zoom-connect/handler.mjs';
import {moduleLoader} from './fixtures/zoom-module-loader.mjs';
import {zoomRuntimeReadiness} from '../supabase/functions/_shared/zoom-setup.mjs';

const environment=()=>({ZOOM_ENVIRONMENT:'test',ZOOM_PUBLIC_ORIGIN:'https://odeir.example.test',ZOOM_REDIRECT_URI:'https://odeir.example.test/api/zoom/callback',ZOOM_OAUTH_CLIENT_ID:'synthetic-oauth-id',ZOOM_OAUTH_CLIENT_SECRET:'synthetic-oauth-secret',ZOOM_WEBHOOK_SECRET:'synthetic-signature',ZOOM_DISPATCH_SECRET:'synthetic-dispatch',SUPABASE_URL:'https://database.example.test',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'});

test('first-use HTTP -> Edge -> real SQL: no settings, explicit initialization, gated activation and first OAuth; no auto activation',async t=>{
 const db=await zoomSetup({complete:true,initializeSettings:false});t.after(()=>db.close());
 const env=environment();let actor=ADMIN_AUTH,providerCalls=0;
 const rpc=async(name,args,asService=false)=>{await service(db,asService);await login(db,actor);return call(db,`public.${name}`,args);};
 const handler=createZoomHandler({env,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).origin,'https://database.example.test');
  const name=new URL(url).pathname.split('/').at(-1);
  try{return Response.json(await rpc(name,JSON.parse(options.body),options.headers.authorization==='Bearer synthetic-service'));}
  catch(error){return Response.json({message:error.message},error.message.includes('forbidden')?{status:403}:{status:409});}
 },clientFactory:()=>{providerCalls++;return {
  authorizationUrl:state=>`https://zoom.us/oauth/authorize?state=${state}`,
  exchangeCode:async()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,scope:'meeting:write:meeting:admin'}),
  identity:async()=>({account_id:'synthetic-account',id:'synthetic-host',display_name:'Synthetic Zoom'})
 };}});
 const gateway=async(action,body)=>{
  const response=await handler(new Request(`https://edge.example.test/zoom-connect/${action}`,{method:'POST',headers:{authorization:'Bearer synthetic-user'},body:JSON.stringify(body)}));
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error),{code:result.error,status:response.status});return result;
 };
 const jar={set(){}};
 const load=moduleLoader({
  [resolve('lib/training-server.js')]:{trainingRpc:async(name,args)=>{try{return await rpc(name,args);}catch(e){throw Object.assign(Error(e.message),{code:e.message,status:/forbidden|permission/.test(e.message)?403:409});}},trainingJson:(body,status=200)=>Response.json(body,{status})},
  [resolve('lib/zoom-server.js')]:{zoomGateway:gateway},'next/headers':{cookies:async()=>jar}
 });
 const {POST}=load('app/api/zoom/[action]/route.js');
 const request=async(action,payload={},commandId=id(9600))=>{
  const r=await POST(new Request(`https://odeir.com/api/zoom/${action}`,{method:'POST',headers:{origin:'https://odeir.com','sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({tenantSlug:'marktone',commandId,payload})}),{params:Promise.resolve({action})});
  return {status:r.status,body:await r.json()};
 };
 let state=await request('snapshot',{view:'accounts'});
 assert.equal(state.status,200,JSON.stringify(state));assert.equal(state.body.settings,null);assert.equal(state.body.setup.initialized,false);
 assert.equal(state.body.setup.runtime.canConnect,false);assert.equal(state.body.setup.authUserId,undefined);
 assert.equal((await db.query('select count(*)::int n from zoom_core.settings')).rows[0].n,0);
 actor=LEARNER_AUTH;assert.equal((await request('initialize',{ownerStaffId:STAFF,environment:'test'})).status,403);
 actor=ADMIN_AUTH;
 const initialized=await request('initialize',{ownerStaffId:STAFF,environment:'test'});
 assert.equal(initialized.status,200);assert.equal(initialized.body.enabled,false);
 assert.deepEqual(await request('initialize',{ownerStaffId:STAFF,environment:'test'}),initialized);
 assert.equal((await request('initialize',{ownerStaffId:id(9999),environment:'test'})).status,409);
 assert.equal((await request('activate',{expectedVersion:1,confirmed:true},id(9601))).status,503);
 assert.equal(providerCalls,0);
 env.ZOOM_RUNTIME_ENABLED='true';env.ZOOM_V1_ENABLED='true';
 assert.equal((await request('activate',{expectedVersion:1,confirmed:false},id(9601))).status,400);
 const activated=await request('activate',{expectedVersion:1,confirmed:true},id(9601));
 assert.equal(activated.status,200,JSON.stringify(activated));assert.equal(activated.body.enabled,true);
 assert.deepEqual(await request('activate',{expectedVersion:1,confirmed:true},id(9601)),activated);
 const started=await request('connect',{mode:'add'},id(9602));assert.equal(started.status,200);
 const stateToken=new URL(started.body.authorizeUrl).searchParams.get('state');
 const completed=await gateway('complete',{tenantSlug:'marktone',state:stateToken,code:'synthetic-code'});
 assert.equal(completed.outcome,'connected');
 state=await request('snapshot',{view:'accounts'});assert.equal(state.body.setup.connectedAccounts,1);
 assert.equal(state.body.setup.runtime.canSchedule,false); // Cron is not present in this fixture.
 assert.equal((await db.query('select count(*)::int n from zoom_core.settings where tenant_id=$1',[OTHER])).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from zoom_core.links')).rows[0].n,0);
 assert.doesNotMatch(JSON.stringify(state.body),/synthetic-(oauth-secret|access|refresh|signature|dispatch|service)/);
 env.ZOOM_RUNTIME_ENABLED='false';assert.equal((await request('connect',{mode:'add'},id(9603))).status,503);
 assert.equal((await request('setup')).status,200); // Read-only diagnosis survives rollback.
});

test('setup isolation, revoked authorization, ACLs, replay and settings edits before activation',async t=>{
 const db=await zoomSetup({complete:true,initializeSettings:false});t.after(()=>db.close());
 const args={p_slug:'marktone',p_command_id:id(9700),p_payload:{ownerStaffId:STAFF,environment:'test'}};
 await assert.rejects(()=>call(db,'public.v1_zoom_initialize',{...args,p_slug:'foreign'}),/forbidden/);
 await db.query("select set_config('fixture.zoom_addon','no',false)");
 await assert.rejects(()=>call(db,'public.v1_zoom_initialize',args),/addon_required/);
 await db.query("select set_config('fixture.zoom_addon','yes',false)");
 const initialized=await call(db,'public.v1_zoom_initialize',args);assert.equal(initialized.enabled,false);
 const repeated=await call(db,'public.v1_zoom_initialize',{...args,p_command_id:id(9701)});assert.deepEqual(repeated,initialized);
 assert.equal((await db.query('select count(*)::int n from zoom_core.settings')).rows[0].n,1);
 const changed=await call(db,'public.v1_zoom_settings',{p_slug:'marktone',p_command_id:id(9702),p_payload:{expectedVersion:1,ownerStaffId:STAFF,joinBeforeMinutes:10,recordingPolicy:'off'}});
 assert.equal(changed.revision,2);
 const activate={p_slug:'marktone',p_auth_user_id:ADMIN_AUTH,p_subject_id:ADMIN,p_command_id:id(9703),p_revision:2,p_environment:'test'};
 await service(db,false);await assert.rejects(()=>call(db,'public.v1_zoom_activate',activate),/forbidden/);
 await service(db);await assert.rejects(()=>call(db,'public.v1_zoom_activate',{...activate,p_environment:'production'}),/configuration_missing/);
 await db.query("update access_control.memberships set status='suspended' where tenant_id=$1 and subject_id=$2",[T,ADMIN]);
 await assert.rejects(()=>call(db,'public.v1_zoom_activate',activate),/forbidden/);
 assert.equal((await db.query('select enabled from zoom_core.settings')).rows[0].enabled,false);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.v1_zoom_activate(text,uuid,uuid,uuid,integer,text)','execute') permitted",[role])).rows[0].permitted,false);
 assert.equal((await db.query("select has_function_privilege('anon','public.v1_zoom_setup_snapshot(text)','execute') permitted")).rows[0].permitted,false);
});

test('runtime inspection rejects malformed redirects and does not confuse configuration with live evidence',()=>{
 const env=environment();env.ZOOM_RUNTIME_ENABLED='true';env.ZOOM_V1_ENABLED='true';
 const check=()=>zoomRuntimeReadiness(key=>env[key],{schedulerConfigured:true});
 assert.equal(check().canSchedule,true);assert.equal(check().verification,'configuration_only');
 for(const url of ['https://evil.example/api/zoom/callback','https://odeir.example.test/api/zoom/callback?next=x','https://user@odeir.example.test/api/zoom/callback','http://odeir.example.test/api/zoom/callback']){
  env.ZOOM_REDIRECT_URI=url;assert.equal(check().canConnect,false);
 }
 assert.doesNotMatch(JSON.stringify(check()),/synthetic-oauth-secret|synthetic-signature/);
});
