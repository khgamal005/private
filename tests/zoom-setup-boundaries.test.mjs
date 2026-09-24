import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {moduleLoader} from './fixtures/zoom-module-loader.mjs';
import {createZoomHandler} from '../supabase/functions/zoom-connect/handler.mjs';

test('OAuth completion, cancellation and retry return to accounts and clear the transaction cookie',async()=>{
 const state='a'.repeat(64),deleted=[];let outcome='connected',fail=false;
 const {GET}=moduleLoader({
  'next/headers':{cookies:async()=>({get:()=>({value:JSON.stringify({tenantSlug:'marktone',state})}),delete:cookie=>deleted.push(cookie)})},
  [resolve('lib/zoom-server.js')]:{zoomGateway:async(action,body)=>{
   assert.equal(action,'complete');assert.equal(body.tenantSlug,'marktone');assert.equal(body.state,state);
   if(fail)throw Error('synthetic outage');
   assert.equal(body.cancelled,outcome==='cancelled');
   return {outcome,returnPath:'/tenant/marktone/addons/zoom'};
  }}
 })('app/api/zoom/callback/route.js');
 for(const next of ['connected','cancelled','failed']){
  outcome=next;fail=next==='failed';
  const response=await GET(new Request(`https://odeir.com/api/zoom/callback?state=${state}&${next==='cancelled'?'error=access_denied':'code=synthetic'}`));
  assert.equal(response.status,303);
  assert.equal(response.headers.get('location'),`https://odeir.com/tenant/marktone/addons/zoom?view=accounts&zoom=${next}`);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 }
 assert.deepEqual(deleted,Array.from({length:3},()=>({name:'odeir_zoom_oauth',path:'/api/zoom'})));
});

test('OAuth state mismatch and foreign return path cannot change the destination or complete another tenant',async()=>{
 const state='b'.repeat(64);let calls=0;
 const {GET}=moduleLoader({
  'next/headers':{cookies:async()=>({get:()=>({value:JSON.stringify({tenantSlug:'marktone',state})}),delete(){}})},
  [resolve('lib/zoom-server.js')]:{zoomGateway:async()=>{calls++;return {outcome:'connected',returnPath:'/tenant/foreign/addons/zoom'};}}
 })('app/api/zoom/callback/route.js');
 const mismatch=await GET(new Request(`https://odeir.com/api/zoom/callback?state=${'c'.repeat(64)}&code=synthetic`));
 assert.equal(calls,0);assert.equal(new URL(mismatch.headers.get('location')).pathname,'/');
 const foreign=await GET(new Request(`https://odeir.com/api/zoom/callback?state=${state}&code=synthetic`));
 assert.equal(foreign.headers.get('location'),'https://odeir.com/tenant/marktone/addons/zoom?view=accounts&zoom=failed');
});

test('closed-runtime readiness requires authorization before probing service metadata and never creates a provider client',async()=>{
 const requested=[];let permitted=false;
 const handler=createZoomHandler({env:{SUPABASE_URL:'https://database.example.test',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'},
  clientFactory:()=>{assert.fail('readiness must not contact Zoom');},fetchImpl:async(url,options)=>{
   const name=new URL(url).pathname.split('/').at(-1);requested.push(name);
   if(name==='v1_zoom_runtime_probe'){
    assert.equal(options.headers.authorization,'Bearer synthetic-service');return Response.json({schedulerConfigured:false});
   }
   assert.equal(options.headers.authorization,'Bearer synthetic-user');
   if(!permitted)return Response.json({message:'zoom_forbidden'},{status:403});
   return Response.json(name==='v1_zoom_setup_snapshot'?{authUserId:'private-user',subjectId:'private-subject',initialized:false}:true);
  }});
 const request=(action,authorization)=>handler(new Request(`https://edge.example.test/zoom-connect/${action}`,{method:'POST',headers:authorization?{authorization}:{},body:JSON.stringify({tenantSlug:'marktone'})}));
 for(const action of ['setup','platform_setup']){
  requested.length=0;assert.equal((await request(action)).status,401);assert.deepEqual(requested,[]);
  const denied=await request(action,'Bearer synthetic-user');assert.equal(denied.status,409);assert.equal((await denied.json()).error,'zoom_forbidden');
  assert.equal(requested.length,1);assert.notEqual(requested[0],'v1_zoom_runtime_probe');
 }
 permitted=true;requested.length=0;
 const allowed=await request('setup','Bearer synthetic-user'),body=await allowed.json();
 assert.equal(allowed.status,200);assert.equal(body.runtime.canConnect,false);assert.equal(body.initialized,false);
 assert.equal(body.authUserId,undefined);assert.equal(body.subjectId,undefined);
 assert.doesNotMatch(JSON.stringify(body),/synthetic-service|private-user|private-subject/);
 assert.deepEqual(requested,['v1_zoom_setup_snapshot','v1_zoom_runtime_probe']);
});
