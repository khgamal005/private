import assert from 'node:assert/strict';
import test from 'node:test';
import {handleGA4} from '../supabase/functions/google-ads-connect/ga4-handler.mjs';
import {publicError} from '../supabase/functions/google-ads-connect/handler.mjs';
const id='20000000-0000-4000-8000-000000000001';
function fixture(overrides={}){const calls=[];return {calls,args:{route:'ga4-assets',body:{commandId:id},tenantSlug:'fixture',publicError,
 user:async name=>{calls.push(name);if(overrides.deny)throw new Error('forbidden');return overrides.run||{runId:id,leaseToken:id};},
 service:async(name,p)=>{calls.push({name,p});return name==='ga4_credentials'?{refreshToken:'synthetic-secret'}:{status:p.p_success?'success':'failed'};},
 google:()=>({refreshAccessToken:async()=>{calls.push('refresh');return {accessToken:'synthetic-access',scope:overrides.scope??'https://www.googleapis.com/auth/analytics.readonly'};}}),
 fetchImpl:async()=>{calls.push('provider');return Response.json(overrides.response||{accountSummaries:[{propertySummaries:[{property:'properties/1234',displayName:'Fixture'}]}]},{status:overrides.status||200});}}};}
test('GA4 authorization precedes all credentials and provider requests',async()=>{const h=fixture({deny:true});await assert.rejects(handleGA4(h.args),/forbidden/);assert.deepEqual(h.calls,['ga4_begin']);});
test('duplicate GA4 job never reads secrets or refreshes',async()=>{const h=fixture({run:{duplicate:true,status:'success'}});assert.equal((await handleGA4(h.args)).duplicate,true);assert.deepEqual(h.calls,['ga4_begin']);});
test('GA4 discovers properties through service lease and returns only safe status',async()=>{const h=fixture();const r=await handleGA4(h.args);assert.equal(r.status,'success');assert.doesNotMatch(JSON.stringify(r),/synthetic-secret|synthetic-access/);assert.equal(h.calls.at(-1).p.p_payload.properties[0].id,'1234');});
test('revoked Analytics scope cannot call Analytics and failure preserves prior snapshot',async()=>{const h=fixture({scope:'https://www.googleapis.com/auth/adwords'});await assert.rejects(handleGA4(h.args),/ga4_consent_required/);assert.ok(!h.calls.includes('provider'));assert.equal(h.calls.at(-1).p.p_success,false);assert.equal(h.calls.at(-1).p.p_error,'ga4_consent_required');});
test('provider errors never leak provider error bodies into audit completion',async()=>{const h=fixture({status:403,response:{error:'PRIVATE secret'}});await assert.rejects(handleGA4(h.args),/ga4_access_denied/);assert.equal(h.calls.at(-1).p.p_error,'ga4_access_denied');assert.doesNotMatch(JSON.stringify(h.calls.at(-1)),/PRIVATE/);});
test('disabled Admin API and missing consent are preserved as safe failure codes without saving a partial discovery',async()=>{
 for(const [reason,code] of [['SERVICE_DISABLED','ga4_admin_api_disabled'],['ACCESS_TOKEN_SCOPE_INSUFFICIENT','ga4_consent_required']]){
  const h=fixture({status:403,response:{error:{message:'PRIVATE provider detail',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason}]}}});
  await assert.rejects(handleGA4(h.args),error=>error.code===code);
  const finish=h.calls.at(-1);assert.equal(finish.name,'ga4_finish');assert.equal(finish.p.p_success,false);assert.equal(finish.p.p_error,code);assert.deepEqual(finish.p.p_payload,{});
  assert.doesNotMatch(JSON.stringify(finish),/PRIVATE|synthetic-secret|synthetic-access/);
 }
 assert.equal(publicError('ga4_data_api_disabled'),'ga4_data_api_disabled');
});
