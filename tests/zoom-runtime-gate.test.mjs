import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoomHandler} from '../supabase/functions/zoom-connect/handler.mjs';
import {hmac} from '../supabase/functions/_shared/zoom-evidence.mjs';

const request=(action,headers={})=>new Request(`https://edge.example.test/zoom-connect/${action}`,{method:'POST',headers,body:'{}'});

test('prepared Zoom deployment blocks every ingress without RPC, provider or body processing',async()=>{
 for(const flag of [undefined,'false','1','TRUE']){
  let calls=0;
  const handler=createZoomHandler({env:{ZOOM_RUNTIME_ENABLED:flag,ZOOM_V1_ENABLED:'true',ZOOM_ENVIRONMENT:'production',ZOOM_DISPATCH_SECRET:'synthetic'},fetchImpl:async()=>{calls++;throw Error('Network must remain unused');},clientFactory:()=>{calls++;throw Error('Provider must remain unused');}});
  for(const action of ['start','complete','sync_hosts','sync_busy','resolve','webinar_register','transcript','sdk','verify_host','join','instructor_start','webhook','dispatch']){
   const result=await handler(request(action,{'authorization':'Bearer synthetic','x-odeir-zoom-dispatch':'synthetic'}));
   assert.equal(result.status,503,`${flag}: ${action}`);
   assert.equal((await result.json()).error,'zoom_not_enabled');
  }
  assert.equal(calls,0);
 }
});

test('after runtime activation V1 pause preserves authenticated cleanup without provider work',async()=>{
 const rpc=[];let provider=0;
 const handler=createZoomHandler({env:{ZOOM_RUNTIME_ENABLED:'true',ZOOM_V1_ENABLED:'false',ZOOM_ENVIRONMENT:'test',ZOOM_DISPATCH_SECRET:'synthetic',SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},fetchImpl:async url=>{rpc.push(new URL(url).pathname);return Response.json({});},clientFactory:()=>{provider++;throw Error('Provider must remain paused');}});
 assert.equal((await handler(request('dispatch'))).status,401);
 assert.deepEqual(rpc,[]);
 const result=await handler(request('dispatch',{'x-odeir-zoom-dispatch':'synthetic'}));
 assert.equal(result.status,200);
 assert.deepEqual(await result.json(),{state:'paused'});
 assert.deepEqual(rpc,['/rest/v1/rpc/v1_zoom_process_events','/rest/v1/rpc/v1_zoom_purge']);
 assert.equal(provider,0);
 assert.equal((await handler(request('start'))).status,503);
});

test('runtime rollback closes a previously valid signed webhook before durable receipt',async()=>{
 let enabled='true',calls=0;
 const values={ZOOM_V1_ENABLED:'false',ZOOM_ENVIRONMENT:'test',ZOOM_WEBHOOK_SECRET:'synthetic',SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
 const handler=createZoomHandler({env:key=>key==='ZOOM_RUNTIME_ENABLED'?enabled:values[key],fetchImpl:async()=>{calls++;return Response.json({status:'stored'});}});
 const timestamp=String(Math.floor(Date.now()/1000));
 const raw=JSON.stringify({event:'meeting.started',event_ts:Date.now(),payload:{account_id:'synthetic-account',object:{id:12345678901,uuid:'synthetic-instance',start_time:new Date().toISOString()}}});
 const signature=`v0=${await hmac(values.ZOOM_WEBHOOK_SECRET,`v0:${timestamp}:${raw}`)}`;
 const webhook=()=>new Request('https://edge.example.test/zoom-connect/webhook',{method:'POST',headers:{'x-zm-request-timestamp':timestamp,'x-zm-signature':signature},body:raw});
 assert.equal((await handler(webhook())).status,200);assert.equal(calls,1);
 enabled='false';
 assert.equal((await handler(webhook())).status,503);assert.equal(calls,1);
});
