import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleSlug,safeCompletionPath,newBrowserTransaction} from '../lib/google-ads/protocol.mjs';
import {requestGoogleAction} from '../lib/google-ads/ui.mjs';
import {createGoogleAdsHandler} from '../supabase/functions/google-ads-connect/handler.mjs';
import {createGoogleAdsClient} from '../lib/google-ads/client.mjs';

test('canonical Reef reaches authorization; defensive alias and unsafe redirects stay denied',async()=>{
 assert.equal(eligibleSlug('reef-skills'),true);
 assert.equal(eligibleSlug('reefskills'),false);
 assert.equal(safeCompletionPath('/tenant/reef-skills/reports/google-ads?google_ads=connected'),'/tenant/reef-skills/reports/google-ads?google_ads=connected');
 assert.equal(safeCompletionPath('/tenant/reefskills/reports/google-ads'),'/');
 let called=0;
 await assert.rejects(requestGoogleAction({name:'assets',slug:'reef-skills',fetcher:async(url,init)=>{
  called++;assert.equal(JSON.parse(init.body).tenantSlug,'reef-skills');
  return new Response(JSON.stringify({ok:false,error:'addon_not_enabled'}),{status:403});
 }}),/addon_not_enabled/);
 assert.equal(called,1);
});

test('unapproved Reef fails before provider authorization; tokenless Cloud configuration is accepted',async()=>{
 const tx=newBrowserTransaction();let providerCalls=0;
 const env={GOOGLE_ADS_CLIENT_ID:'fixture',GOOGLE_ADS_CLIENT_SECRET:'fixture-secret',GOOGLE_ADS_REDIRECT_URI:'https://odeir.com/api/tenant/google-ads/callback',SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'fixture-anon'};
 const handle=createGoogleAdsHandler({env,createClient:()=>({authorizationUrl(){providerCalls++;return 'https://accounts.google.com/o/oauth2/v2/auth';}}),fetchImpl:async()=>new Response(JSON.stringify({message:'google_ads_protected_tenant'}),{status:400})});
 const response=await handle(new Request('https://fixture.invalid/start',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({tenantSlug:'reef-skills',state:tx.state,codeChallenge:tx.codeChallenge,returnPath:'/tenant/reef-skills/reports/google-ads'})}));
 assert.equal(response.status,403);assert.equal((await response.json()).error,'protected_tenant');assert.equal(providerCalls,0);
 const review=await handle(new Request('https://fixture.invalid/review',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({tenantSlug:'reef-skills'})}));
 assert.equal((await review.json()).error,'reporting_only');assert.equal(providerCalls,0);
});

test('Google API calls no longer require or send a developer-token header',async()=>{
 let calls=0;
 const client=createGoogleAdsClient({clientId:'fixture',clientSecret:'fixture-secret',redirectUri:'https://odeir.com/api/tenant/google-ads/callback'}, {fetchImpl:async(url,init)=>{
  calls++;assert.equal(Object.hasOwn(init.headers,'developer-token'),false);
  return new Response(JSON.stringify({resourceNames:[]}),{headers:{'content-type':'application/json'}});
 }});
 const found=await client.discoverAccounts({accessToken:'fixture-access'});
 assert.equal(calls,1);assert.deepEqual(found.accounts,[]);
});
