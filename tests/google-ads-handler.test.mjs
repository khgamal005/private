import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleAdsHandler,boundedJson,publicError} from '../supabase/functions/google-ads-connect/handler.mjs';
import {newBrowserTransaction,pkceChallenge,stateCookieName,safeCompletionPath,sameOriginMutation,trustedAuthorizeUrl} from '../lib/google-ads/protocol.mjs';

const TX='ac406ee2-2c89-45e3-8dc1-b4f15104cc65';
const SCOPE='https://www.googleapis.com/auth/adwords';
const env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture',
  GOOGLE_ADS_CLIENT_ID:'fixture-client',GOOGLE_ADS_CLIENT_SECRET:'fixture-secret',GOOGLE_ADS_DEVELOPER_TOKEN:'fixture-developer',
  GOOGLE_ADS_REDIRECT_URI:'https://odeir.com/api/tenant/google-ads/callback'};
const account={customerId:'1234567890',currency:'SAR',timezone:'Asia/Riyadh',name:'Fixture only'};
const run={runId:TX,leaseToken:TX,status:'running',credentialVersion:1};
function harness({rpc={},client={},customEnv={}}={}){
  const calls=[],failures=[];
  const handler=createGoogleAdsHandler({env:{...env,...customEnv},
    logFailure:event=>failures.push(event),
    fetchImpl:async(url,options)=>{
      const suffix=url.split('/').at(-1).replace(/^v1_(tenant|service)_google_ads_/,'');
      calls.push({kind:'rpc',suffix,body:JSON.parse(options.body),headers:options.headers});
      const value=rpc[suffix]??({snapshot:{accounts:[account]},begin_sync:run,sync_credentials:{refreshToken:'server-refresh',account},finish_sync:{status:'success',metricRows:1},
        claim_oauth:{transactionId:TX,tenantSlug:'demo-training',returnPath:'/tenant/demo-training/reports/google-ads'},finalize_oauth:{status:'connected'}}[suffix]||{});
      if(value instanceof Error)return Response.json({message:value.message},{status:value.status||400});
      return Response.json(typeof value==='function'?value(JSON.parse(options.body)):value);
    },
    createClient:()=>{
      const defaults={authorizationUrl:()=> 'https://accounts.google.com/o/oauth2/v2/auth',
        exchangeCode:()=>({accessToken:'server-access',refreshToken:'server-refresh',scope:SCOPE}),
        discoverAccounts:()=>({accounts:[account],truncated:false}),
        refreshAccessToken:()=>({accessToken:'server-access'}),
        fetchCampaignReport:()=>({campaigns:[{externalCampaignId:'25',name:'Fixture'}],daily:[{date:'2026-09-01',externalCampaignId:'25',costMicros:'1500000'}]})};
      return Object.fromEntries(Object.keys(defaults).map(name=>[name,async(args)=>{
        calls.push({kind:'google',name});
        if(client[name] instanceof Error)throw client[name];
        return (client[name]||defaults[name])(args);
      }]));
    }
  });
  async function request(action,body={},headers={authorization:'Bearer user-fixture'}){
    const response=await handler(new Request('https://fixture.invalid/functions/v1/google-ads-connect/'+action,{
      method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)
    }));
    return {status:response.status,body:await response.json()};
  }
  return {request,calls,failures};
}
const syncBody={tenantSlug:'demo-training',dateFrom:'2026-09-01',dateTo:'2026-09-09',commandId:TX};

test('protected tenant and missing auth never reach RPC or Google',async()=>{
  const h=harness();
  assert.equal((await h.request('sync',{...syncBody,tenantSlug:'reefskills'})).status,403);
  assert.equal((await h.request('sync',syncBody,{})).status,401);
  assert.equal((await h.request('sync',syncBody,{authorization:'Bearer user-fixture',origin:'https://evil.invalid'})).status,403);
  assert.equal(h.calls.length,0);
});
test('disabled/unauthorized tenant cannot read credentials or call Google',async()=>{
  for(const code of ['google_ads_not_enabled','google_ads_forbidden']){
    const h=harness({rpc:{begin_sync:new Error(code)}});
    assert.equal((await h.request('sync',syncBody)).status,403);
    assert.deepEqual(h.calls.map(c=>c.suffix),['begin_sync']);
  }
});
test('OAuth claim precedes code exchange and service finalization never exposes credentials',async()=>{
  const h=harness();const tx=newBrowserTransaction();
  const result=await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,code:'fixture-code'});
  assert.equal(result.status,200);
  assert.equal(result.body.returnPath,'/tenant/demo-training/reports/google-ads?google_ads=connected');
  assert.deepEqual(h.calls.map(c=>c.suffix||c.name),['claim_oauth','exchangeCode','discoverAccounts','finalize_oauth']);
  assert.equal(h.calls[0].body.p_pkce_challenge,pkceChallenge(tx.verifier));
  assert.equal(h.calls[0].headers.authorization,'Bearer user-fixture');
  assert.equal(h.calls.at(-1).headers.authorization,'Bearer service-fixture');
  assert.doesNotMatch(JSON.stringify(result),/server-refresh|server-access|fixture-secret/);
});
test('invalid, replayed, cancelled or protected OAuth cannot exchange a code',async()=>{
  const tx=newBrowserTransaction();
  for(const rpc of [new Error('google_ads_oauth_invalid'),{transactionId:TX,tenantSlug:'reefskills',returnPath:'/tenant/reefskills/reports/google-ads'}]){
    const h=harness({rpc:{claim_oauth:rpc}});
    assert.notEqual((await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,code:'fixture'})).status,200);
    assert.equal(h.calls.filter(c=>c.kind==='google').length,0);
  }
  const h=harness();
  assert.equal((await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,cancelled:true})).body.returnPath,'/tenant/demo-training/reports/google-ads?google_ads=cancelled');
  assert.equal(h.calls.filter(c=>c.kind==='google').length,0);
});
test('missing scope or incomplete discovery cannot finalize OAuth',async()=>{
  const tx=newBrowserTransaction();
  for(const client of [{exchangeCode:()=>({accessToken:'fixture',refreshToken:'fixture',scope:'openid'})},{discoverAccounts:()=>({accounts:[account],truncated:true})}]){
    const h=harness({client});
    assert.equal((await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,code:'fixture'})).status,400);
    assert.ok(!h.calls.some(c=>c.suffix==='finalize_oauth'));
  }
});

test('post-claim OAuth failures retain only the authorized return path and redacted diagnostic enums',async()=>{
  const tx=newBrowserTransaction();
  const cases=[
    {client:{exchangeCode:new Error('private-provider-code')},stage:'token_exchange',code:'google_oauth_exchange_failed'},
    {client:{exchangeCode:new Error('google_oauth_configuration_invalid')},stage:'token_exchange',code:'configuration_missing'},
    {client:{discoverAccounts:new Error('private-access-token')},stage:'account_discovery',code:'google_accounts_unavailable'},
    {rpc:{finalize_oauth:new Error('private-database-message')},stage:'connection_save',code:'google_connection_save_failed'},
    {rpc:{finalize_oauth:new Error('google_ads_no_eligible_accounts')},stage:'connection_save',code:'no_eligible_ads_accounts'}
  ];
  for(const fixture of cases){
    const h=harness(fixture);
    const result=await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,code:'private-code'});
    assert.equal(result.body.error,fixture.code);
    assert.equal(result.body.returnPath,'/tenant/demo-training/reports/google-ads');
    assert.deepEqual(h.failures,[{transactionId:TX,stage:fixture.stage,error:fixture.code}]);
    assert.doesNotMatch(JSON.stringify([result,h.failures]),/private|server-refresh|server-access|fixture-secret/);
  }
});

test('failed claim cannot disclose a tenant destination or emit a claimed transaction diagnostic',async()=>{
  const tx=newBrowserTransaction();
  for(const context of [new Error('google_ads_forbidden'),new Error('google_ads_oauth_stale'),
    {transactionId:TX,tenantSlug:'demo-training',returnPath:'https://evil.invalid'}]){
    const h=harness({rpc:{claim_oauth:context}});
    const result=await h.request('complete',{state:tx.state,codeVerifier:tx.verifier,code:'private-code'});
    assert.equal('returnPath' in result.body,false);
    assert.equal(h.failures.length,0);
    assert.ok(!h.calls.some(call=>call.kind==='google'));
  }
});
test('complete report only replaces metrics after full fetch and authorized lease',async()=>{
  const h=harness();
  assert.equal((await h.request('sync',syncBody)).body.status,'success');
  assert.deepEqual(h.calls.map(c=>c.suffix||c.name),['begin_sync','sync_credentials','refreshAccessToken','fetchCampaignReport','finish_sync']);
  const finish=h.calls.at(-1);
  assert.equal(finish.body.p_success,true);
  assert.equal(finish.body.p_metrics.length,1);
});
test('partial Google failure preserves old metrics and records only redacted error',async()=>{
  const h=harness({client:{fetchCampaignReport:new Error('secret Google error with token=PRIVATE')}});
  const response=await h.request('sync',syncBody);
  assert.equal(response.body.error,'request_rejected');
  const finish=h.calls.at(-1);
  assert.equal(finish.suffix,'finish_sync');assert.equal(finish.body.p_success,false);
  assert.deepEqual(finish.body.p_metrics,[]);assert.deepEqual(finish.body.p_campaigns,[]);
  assert.doesNotMatch(JSON.stringify(response),/PRIVATE/);
});
test('stale lease cannot reach Google and duplicate command cannot execute twice',async()=>{
  const stale=harness({rpc:{sync_credentials:new Error('google_ads_stale_lease')}});
  assert.equal((await stale.request('sync',syncBody)).status,400);
  assert.ok(!stale.calls.some(c=>c.kind==='google'));
  const duplicate=harness({rpc:{begin_sync:{...run,duplicate:true,status:'success'}}});
  assert.equal((await duplicate.request('sync',syncBody)).body.duplicate,true);
  assert.deepEqual(duplicate.calls.map(c=>c.suffix),['begin_sync']);
});
test('invalid dates, oversize source review and duplicate preview rows fail before RPC',async()=>{
  const h=harness();
  for(const dates of [{dateFrom:'2026-02-30'},{dateFrom:'2026-07-01'},{dateTo:'2026-08-01'}]){
    assert.equal((await h.request('sync',{...syncBody,...dates})).status,400);
  }
  const row={originKey:'one',previewToken:'one'};
  assert.equal((await h.request('review',{tenantSlug:'demo-training',commandId:TX,campaignId:'25',rows:[row,row],reason:'fixture'})).status,400);
  assert.equal(h.calls.length,0);
});
test('bounded JSON limits actual stream bytes, rejects arrays and redacts unknown errors',async()=>{
  await assert.rejects(()=>boundedJson(new Request('https://fixture.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data:'a'.repeat(66000)})})),/payload_too_large/);
  await assert.rejects(()=>boundedJson(new Request('https://fixture.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'[]'})),/invalid_request/);
  assert.equal(publicError(new Error('private body')),'request_rejected');
});
test('browser transaction and redirect protocol reject substitution and unsafe origins',()=>{
  const tx=newBrowserTransaction(),other=newBrowserTransaction();
  assert.notEqual(stateCookieName(tx.state),stateCookieName(other.state));
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({state:tx.state,code_challenge:tx.codeChallenge,code_challenge_method:'S256',response_type:'code',scope:SCOPE,redirect_uri:env.GOOGLE_ADS_REDIRECT_URI}))url.searchParams.set(key,value);
  assert.equal(trustedAuthorizeUrl(url.href,'https://odeir.com',tx),url.href);
  assert.throws(()=>trustedAuthorizeUrl(url.href,'https://odeir.com',other));
  assert.equal(safeCompletionPath('//evil.invalid/tenant/demo-training/reports/google-ads'),'/');
  assert.equal(safeCompletionPath('/tenant/reefskills/reports/google-ads'),'/');
  assert.equal(safeCompletionPath('/tenant/demo-training/reports/google-ads?google_ads=connected&token=secret'),'/tenant/demo-training/addons/google-kit?google_ads=connected');
  assert.equal(sameOriginMutation(new Request('https://odeir.com/api/tenant/google-ads/start',{headers:{origin:'https://evil.invalid','content-type':'application/json'}})),false);
});
