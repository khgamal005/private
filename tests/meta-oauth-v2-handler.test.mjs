import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';

test('OAuth handler enforces authenticated claims and rejects excessive grants',async(t)=>{
  const originalDeno=globalThis.Deno,originalFetch=globalThis.fetch;
  let handler;
  const config={SUPABASE_URL:'https://database.example',SUPABASE_ANON_KEY:'a'.repeat(32),
    SUPABASE_SERVICE_ROLE_KEY:'s'.repeat(32),META_CONNECT_V2_APP_ID:'123456789',
    META_CONNECT_V2_APP_SECRET:'test-app-secret-placeholder',META_CONNECT_V2_LOGIN_CONFIG_ID:'987654321',
    META_CONNECT_V2_GRAPH_VERSION:'v26.0',META_CONNECT_V2_RETURN_ORIGIN:'https://odeir.com'};
  globalThis.Deno={env:{get:key=>config[key]},serve:fn=>{handler=fn;}};
  const source=await readFile(new URL('../supabase/functions/meta-oauth-v2/index.ts',import.meta.url),'utf8');
  const securityUrl=new URL('../supabase/functions/meta-oauth-v2/security.mjs',import.meta.url).href;
  const moduleSource=stripTypeScriptTypes(source.replace('import "jsr:@supabase/functions-js/edge-runtime.d.ts";','')
    .replace("'./security.mjs'",JSON.stringify(securityUrl)),{mode:'transform'});
  try{
    await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
    let calls=[],scopes=['ads_read','public_profile'],claimAllowed=true;
    globalThis.fetch=async(input,init={})=>{
      const url=new URL(input),body=init.body?String(init.body):'';
      calls.push({url,init,body});
      const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
      if(url.pathname.endsWith('begin_oauth'))return reply({});
      if(url.pathname.endsWith('claim_oauth')){
        assert.equal(init.headers.authorization,'Bearer tenant-session');
        return claimAllowed?reply({transactionId:'transaction',returnPath:'/tenant/demo/addons/social-connect'}):
          reply({message:'forbidden'},403);
      }
      if(url.pathname.endsWith('/oauth/access_token'))return reply({access_token:'provider-token-'.repeat(4),expires_in:5184000});
      if(url.pathname.endsWith('/debug_token'))return reply({data:{is_valid:true,type:'USER',app_id:'123456789',
        user_id:'123123123',scopes,expires_at:Math.floor(Date.now()/1000)+5184000}});
      if(url.pathname.endsWith('finalize_oauth'))return reply({status:'connected'});
      if(url.pathname.endsWith('authorize_ads_action'))return reply({
        tenantId:'tenant',connectionId:'connection',actorSubjectId:'actor'
      });
      if(url.pathname.endsWith('token_context'))return reply({
        accessToken:'provider-token-'.repeat(4)
      });
      if(url.pathname.endsWith('/me/adaccounts'))return reply({data:[{
        id:'act_123456789',name:'Demo Ads',currency:'SAR',
        timezone_name:'Asia/Riyadh',account_status:1,
        business:{id:'987',name:'Demo Business'}
      }]});
      if(url.pathname.endsWith('bind_ad_account'))return reply({
        status:'selected',externalAccountId:'123456789'
      });
      throw new Error('Unexpected request: '+url.pathname);
    };
    const request=(route,body,authorized=true)=>new Request('https://database.example/functions/v1/meta-oauth-v2/'+route,{
      method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer tenant-session'}:{})},
      body:JSON.stringify(body)});
    await t.test('start produces the exact ODEIR callback with code response',async()=>{
      const response=await handler(request('start',{tenantSlug:'demo',returnPath:'/tenant/demo/addons/social-connect'}));
      const data=await response.json(),url=new URL(data.authorizeUrl);
      assert.equal(url.searchParams.get('redirect_uri'),'https://odeir.com/api/tenant/social-connect/callback');
      assert.equal(url.searchParams.get('override_default_response_type'),'true');
      assert.equal(url.searchParams.get('state').length,64);
    });
    await t.test('completion without a bearer session cannot consume state',async()=>{
      calls=[];const response=await handler(request('complete',{state:'a'.repeat(64),code:'code'},false));
      assert.equal(response.status,401);assert.equal(calls.length,0);
    });
    await t.test('oversized undeclared request body is rejected before any RPC',async()=>{
      calls=[];
      const response=await handler(request('complete',{state:'a'.repeat(64),code:'x'.repeat(20_000)}));
      assert.equal((await response.json()).error,'payload_too_large');
      assert.equal(calls.length,0);
    });
    await t.test('wrong actor is rejected before provider token exchange',async()=>{
      calls=[];claimAllowed=false;
      await handler(request('complete',{state:'a'.repeat(64),code:'code'}));
      assert.equal(calls.length,1);claimAllowed=true;
    });
    await t.test('write permissions cannot enter Vault',async()=>{
      calls=[];scopes=['ads_read','business_management'];
      const response=await handler(request('complete',{state:'a'.repeat(64),code:'code'}));
      assert.match((await response.json()).returnPath,/excessive_scopes_granted/);
      assert.equal(calls.some(c=>c.url.pathname.endsWith('finalize_oauth')),false);
    });
    await t.test('read-only grant is finalized without exposing provider token',async()=>{
      calls=[];scopes=['ads_read','public_profile'];
      const response=await handler(request('complete',{state:'a'.repeat(64),code:'code'}));
      const result=await response.text();
      assert.match(result,/social_connect=connected/);assert.doesNotMatch(result,/provider-token/);
      assert.equal(calls.filter(c=>c.url.pathname.endsWith('finalize_oauth')).length,1);
    });
    await t.test('account discovery never exposes the token and selection is server verified',async()=>{
      calls=[];
      const assets=await handler(request('assets',{tenantSlug:'demo'}));
      const assetBody=await assets.json();
      assert.equal(assetBody.accounts[0].externalAccountId,'123456789');
      assert.doesNotMatch(JSON.stringify(assetBody),/provider-token/);
      const metaCall=calls.find(c=>c.url.pathname.endsWith('/me/adaccounts'));
      assert.match(metaCall.url.searchParams.get('appsecret_proof'),/^[a-f0-9]{64}$/);
      assert.equal(metaCall.init.headers.authorization,'Bearer '+'provider-token-'.repeat(4));

      calls=[];
      const selected=await handler(request('select',{
        tenantSlug:'demo',externalAccountId:'123456789'
      }));
      assert.equal((await selected.json()).status,'selected');
      assert.equal(calls.some(c=>c.url.pathname.endsWith('bind_ad_account')),true);
    });
    await t.test('old public callback can no longer exchange a code',async()=>{
      calls=[];const response=await handler(new Request('https://database.example/functions/v1/meta-oauth-v2/oauth/callback?code=code&state='+'a'.repeat(64)));
      assert.equal(response.status,405);assert.equal(calls.length,0);
    });
  }finally{globalThis.Deno=originalDeno;globalThis.fetch=originalFetch;}
});
