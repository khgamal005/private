import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {resolveZoomTrainingMessage} from '../supabase/functions/_shared/zoom-message.mjs';

test('shared training worker preserves legacy delivery and isolates managed Zoom messages',async()=>{
 const source=await readFile(new URL('../supabase/functions/training-automation-dispatch/index.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source+'\nexport {deliver,legacyProviderConfiguration};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let check={managed:false},provider=null;const calls=[];
 const values={ZOOM_PUBLIC_ORIGIN:'https://odeir.example.test',ZOOM_ACCOUNT_ID:'legacy-account',ZOOM_CLIENT_ID:'legacy-id',ZOOM_CLIENT_SECRET:'legacy-secret',ZOOM_OAUTH_CLIENT_ID:'new-id',ZOOM_OAUTH_CLIENT_SECRET:'new-secret'};
 const sandbox={exports:{},Deno:{env:{get:key=>values[key]},serve:()=>{}},Response,Request,URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,crypto,btoa,
  require:name=>{assert.equal(name,'../_shared/zoom-message.mjs');return {resolveZoomTrainingMessage};},
  fetch:async(url,options)=>{
   calls.push({url,body:JSON.parse(options.body),headers:options.headers});
   if(url.endsWith('/v1_zoom_message_check'))return Response.json(check);
   if(url.endsWith('/v2_integration_provider_configuration'))return Response.json(provider);
   assert.equal(url,'https://api.resend.com/emails');return Response.json({id:'synthetic-receipt'});
  }};
 vm.runInNewContext(compiled,sandbox);
 const {deliver,legacyProviderConfiguration}=sandbox.exports;
 const oldConfig=legacyProviderConfiguration();assert.equal(oldConfig.zoom.clientId,'legacy-id');assert.equal(oldConfig.zoom.clientSecret,'legacy-secret');
 const legacy={email:{ready:true,apiKey:'legacy-email',from:'legacy@example.test'}};
 const job={id:'synthetic-job',tenantId:'synthetic-tenant',queue:'training',sessionId:'synthetic-session',type:'joining_instructions',channel:'email',recipient:'student@example.test',subject:'Synthetic',messageText:'Legacy message',attempts:1,metadata:{}};
 const send=next=>deliver(next,'http://127.0.0.1:54321','synthetic-service',legacy);
 assert.equal((await send(job)).state,'sent');assert.equal(calls.at(-1).body.text,'Legacy message');assert.equal(calls.at(-1).headers.authorization,'Bearer legacy-email');
 calls.length=0;check={managed:true,allowed:false,reason:'zoom_not_enabled'};
 await assert.rejects(send(job),/zoom_not_enabled/);assert.equal(calls.length,1);
 calls.length=0;check={managed:true,allowed:true,url:'https://zoom.us/w/123',job:{...job,type:'zoom_invitation',messageText:'Tenant message'}};
 await assert.rejects(send(job),/tenant_provider_required/);assert.ok(calls.every(c=>c.url.startsWith('http://127.0.0.1:54321/')));
 calls.length=0;provider={connectionId:'tenant-provider',providerKey:'resend',channel:'email',publicConfig:{fromEmail:'tenant@example.test',fromName:'Synthetic'},secrets:{apiKey:'tenant-only'}};
 const sent=await send(job);assert.equal(sent.providerConnectionId,'tenant-provider');assert.equal(calls.at(-1).headers.authorization,'Bearer tenant-only');assert.equal(calls.at(-1).headers['Idempotency-Key'],'odeir-training-synthetic-tenant-synthetic-job');
 calls.length=0;check={managed:true,allowed:false,reason:'should_not_apply'};provider=null;
 assert.equal((await send({...job,queue:'automation'})).state,'sent');assert.ok(calls.every(c=>!c.url.endsWith('/v1_zoom_message_check')));
});
