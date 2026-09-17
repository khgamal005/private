import assert from 'node:assert/strict';
import test from 'node:test';
import {createGA4Client,ga4Hostname,GA4_SCOPE} from '../supabase/functions/_shared/ga4-client.mjs';
import {createGoogleAdsClient} from '../supabase/functions/_shared/google-ads-client.mjs';
import {newBrowserTransaction,trustedAuthorizeUrl} from '../lib/google-ads/protocol.mjs';
import {ga4Csv,ga4Insights} from '../lib/google-ads/ga4-ui.mjs';
const property={id:'1234',currency:'SAR',timezone:'Asia/Riyadh',hostname:'store.example'};
const denied = reason => Response.json({error:{message:'PRIVATE provider response',details:[{
 '@type':'type.googleapis.com/google.rpc.ErrorInfo',reason,domain:'googleapis.com',metadata:{consumer:'PRIVATE project'}
}]}},{status:403});
test('disabled Analytics APIs are distinguished from permission and consent failures without exposing provider data',async()=>{
 for(const [reason,discoveryError,reportError] of [
  ['SERVICE_DISABLED','ga4_admin_api_disabled','ga4_data_api_disabled'],
  ['ACCESS_TOKEN_SCOPE_INSUFFICIENT','ga4_consent_required','ga4_consent_required'],
  ['USER_PERMISSION_DENIED','ga4_access_denied','ga4_access_denied']
 ]){
  const c=createGA4Client({fetchImpl:async()=>denied(reason)});
  for(const [operation,expected] of [[()=>c.properties('synthetic'),discoveryError],[()=>c.reports('synthetic',property,'2026-08-01','2026-08-02'),reportError]]){
   await assert.rejects(operation,error=>{assert.equal(error.code,expected);assert.doesNotMatch(JSON.stringify(error),/PRIVATE|synthetic/);return true;});
  }
 }
});
test('permission diagnostics ignore unstructured text, unknown domains and oversized bodies',async()=>{
 const bodies=[
  {error:{message:'SERVICE_DISABLED PRIVATE'}},
  {error:{details:[{'@type':'untrusted',domain:'googleapis.com',reason:'SERVICE_DISABLED'}]}},
  {error:{details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'other.example',reason:'SERVICE_DISABLED'}]}},
  {error:{details:Array(21).fill({'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason:'SERVICE_DISABLED'})}},
  {padding:'x'.repeat(65536),error:{details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason:'SERVICE_DISABLED'}]}}
 ];
 for(const body of bodies)await assert.rejects(createGA4Client({fetchImpl:async()=>Response.json(body,{status:403})}).properties('synthetic'),/^Error: ga4_access_denied$/);
 await assert.rejects(createGA4Client({fetchImpl:async()=>new Response('PRIVATE invalid JSON',{status:403})}).properties('synthetic'),/^Error: ga4_access_denied$/);
});
function response(body,extra={}) {
 const transaction=body.dimensions.some(d=>d.name==='transactionId');
 const values={date:'20260801',transactionId:'0001',hostName:'store.example',sessionSource:'google',sessionMedium:'cpc',sessionGoogleAdsCustomerId:'1234567890',sessionGoogleAdsCampaignId:'9001',sessionCampaignName:'Course',currencyCode:'SAR'};
 return {dimensionHeaders:body.dimensions,metricHeaders:body.metrics,metadata:{currencyCode:'SAR',timeZone:'Asia/Riyadh'},rowCount:1,
 rows:[{dimensionValues:body.dimensions.map(d=>({value:values[d.name]})),metricValues:body.metrics.map(m=>({value:m.name==='grossPurchaseRevenue'?'100.25':transaction?'1':'10'}))}],...extra};
}
test('GA4 fixed reports preserve exact IDs, use currency and domain scope, and request no PII',async()=>{
 const requests=[];const client=createGA4Client({fetchImpl:async(url,options)=>{const b=JSON.parse(options.body);requests.push({url,b});return Response.json(response(b));}});
 const r=await client.reports('synthetic',property,'2026-08-01','2026-08-02');assert.equal(r.transactions[0].transactionId,'0001');assert.equal(r.transactions[0].grossPurchaseRevenue,'100.25');assert.equal(r.traffic[0].sessions,10);
 for(const x of requests){assert.equal(x.url,'https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport');assert.equal(x.b.currencyCode,'SAR');assert.equal(x.b.dimensionFilter.andGroup.expressions[0].filter.fieldName,'hostName');assert.doesNotMatch(JSON.stringify(x.b),/email|phone|userId|clientId|pageLocation/);}
 assert.deepEqual(r.quality.transactions,{thresholded:false,otherRow:false,sampled:false,restricted:false});
});
test('complete pagination required; row count drift, duplicate pages and empty partial fail closed',async()=>{
 for(const mode of ['drift','duplicate','empty']){
  let page=0;const client=createGA4Client({pageSize:1,fetchImpl:async(_url,options)=>{const b=JSON.parse(options.body);page++;const r=response(b,{rowCount:2});if(page>1){if(mode==='drift')r.rowCount=3;if(mode==='empty')r.rows=[];}return Response.json(r);}});
  await assert.rejects(client.reports('x',property,'2026-08-01','2026-08-02'),/ga4_report_changed|ga4_incomplete_report/);
 }
});
test('quotas retry in bounded fashion; missing access and metadata drift do not pass',async()=>{
 let attempts=0;const client=createGA4Client({wait:async()=>{},fetchImpl:async()=>{attempts++;return Response.json({secret:'never surfaced'},{status:429});}});
 await assert.rejects(client.reports('x',property,'2026-08-01','2026-08-02'),/rate_limited/);assert.equal(attempts,3);
 for(const status of [401,403,400])await assert.rejects(createGA4Client({fetchImpl:async()=>Response.json({message:'PRIVATE TOKEN'},{status})}).reports('x',property,'2026-08-01','2026-08-02'),e=>!e.message.includes('PRIVATE'));
 await assert.rejects(createGA4Client({fetchImpl:async(_url,o)=>Response.json(response(JSON.parse(o.body),{metadata:{currencyCode:'USD',timeZone:'Asia/Riyadh'}}))}).reports('x',property,'2026-08-01','2026-08-02'),/ga4_property_changed/);
});
test('limited reports carry explicit quality flags instead of appearing complete',async()=>{
 const c=createGA4Client({fetchImpl:async(_url,o)=>Response.json(response(JSON.parse(o.body),{metadata:{currencyCode:'SAR',timeZone:'Asia/Riyadh',subjectToThresholding:true,dataLossFromOtherRow:true,samplingMetadatas:[{samplesReadCount:'10',samplingSpaceSize:'20'}],schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'grossPurchaseRevenue'}]}}}))});
 assert.deepEqual((await c.reports('x',property,'2026-08-01','2026-08-02')).quality.transactions,{thresholded:true,otherRow:true,sampled:true,restricted:true});
});
test('property selection verifies the selected store against a real web stream',async()=>{
 const c=createGA4Client({fetchImpl:async url=>Response.json(url.includes('dataStreams')?{dataStreams:[{type:'WEB_DATA_STREAM',webStreamData:{defaultUri:'https://www.store.example'}}]}:{name:'properties/1234',currencyCode:'SAR',timeZone:'Asia/Riyadh',displayName:'Store'})});
 assert.equal((await c.property('x','1234','https://store.example')).hostname,'store.example');
 await assert.rejects(c.property('x','1234','https://other.example'),/ga4_store_mismatch/);
 assert.throws(()=>ga4Hostname('https://user:pass@store.example'),/ga4_invalid_store/);
});
test('GA4 consent is optional and browser-bound; default Ads flow remains unchanged',()=>{
 const c=createGoogleAdsClient({clientId:'x',clientSecret:'x',developerToken:'x',redirectUri:'https://odeir.com/api/tenant/google-ads/callback'});
 const t={...newBrowserTransaction(),includeAnalytics:true};const url=c.authorizationUrl({...t});assert.ok(new URL(url).searchParams.get('scope').includes(GA4_SCOPE));
 assert.equal(trustedAuthorizeUrl(url,'https://odeir.com',t),url);assert.throws(()=>trustedAuthorizeUrl(url,'https://odeir.com',{...t,includeAnalytics:false}));
 assert.equal(new URL(c.authorizationUrl({...t,includeAnalytics:false})).searchParams.get('scope'),'https://www.googleapis.com/auth/adwords');
});

test('web stream selection works independently of commerce, remains property-bound and filters both reports',async()=>{
 const requests=[];
 const streams=[{name:'properties/1234/dataStreams/5678',type:'WEB_DATA_STREAM',displayName:'Website',webStreamData:{defaultUri:'https://www.store.example'}},{name:'properties/1234/dataStreams/7777',type:'WEB_DATA_STREAM',displayName:'Second site',webStreamData:{defaultUri:'https://other.example'}},{name:'properties/1234/dataStreams/8888',type:'ANDROID_APP_DATA_STREAM'}];
 const client=createGA4Client({fetchImpl:async(url,options)=>{
  if(options.body){const body=JSON.parse(options.body);requests.push(body);return Response.json(response(body));}
  return Response.json(url.includes('dataStreams')?{dataStreams:streams}:{name:'properties/1234',currencyCode:'SAR',timeZone:'Asia/Riyadh',displayName:'Website'});
 }});
 assert.deepEqual(await client.streams('x','1234'),[{id:'5678',name:'Website',hostname:'store.example'},{id:'7777',name:'Second site',hostname:'other.example'}]);
 const selected=await client.property('x','1234',null,'5678');assert.equal(selected.hostname,'store.example');assert.equal(selected.streamId,'5678');
 await client.reports('x',selected,'2026-08-01','2026-08-02');
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.dimensionFilter.andGroup.expressions.some(e=>e.filter.fieldName==='streamId'&&e.filter.stringFilter.value==='5678')));
 await assert.rejects(client.property('x','1234',null),/ga4_stream_required/);
 await assert.rejects(client.property('x','1234',null,'9999'),/ga4_stream_required/);
 await assert.rejects(client.property('x','1234','https://other.example','5678'),/ga4_store_mismatch/);
 streams[0].name='properties/9999/dataStreams/5678';await assert.rejects(client.streams('x','1234'),/ga4_invalid_response/);
});
test('CSV is formula-safe, and recommendations expose missing data without inventing performance',()=>{
 const csv=ga4Csv([{transactionId:'=HYPERLINK("bad")',status:'verified'}]);assert.ok(csv.includes("'=HYPERLINK"));
 assert.match(ga4Insights({summary:{pendingPayments:3},coverage:{complete:false}}).join(' '),/3/);
});

test('empty successful GA4 reports may omit proto zero rowCount and remain valid',async()=>{
 const c=createGA4Client({fetchImpl:async(_url,o)=>{const b=JSON.parse(o.body);return Response.json({dimensionHeaders:b.dimensions,metricHeaders:b.metrics,metadata:{currencyCode:'SAR',timeZone:'Asia/Riyadh'}});}});
 const r=await c.reports('x',property,'2026-08-01','2026-08-02');assert.deepEqual(r.transactions,[]);assert.deepEqual(r.traffic,[]);
});
