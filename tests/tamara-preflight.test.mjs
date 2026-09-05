import assert from 'node:assert/strict';
import test from 'node:test';
import {createTamaraPreflight} from '../lib/tamara-preflight.mjs';

const API_TOKEN='test-api-token-0123456789';
const SUBJECT='a668b538-031d-4719-b846-a8a225e7ef89';
const endpoint='https://odeir.com/api/platform/tamara-preflight';
const SUPABASE='https://database.example.test';
const RPC=`${SUPABASE}/rest/v1/rpc/v3_platform_payment_provider_admin_snapshot`;
const request=(body={environment:'sandbox',apiToken:API_TOKEN},headers={})=>
  new Request(endpoint,{method:'POST',headers:{
    origin:'https://odeir.com','sec-fetch-site':'same-origin',
    'content-type':'application/json',...headers
  },body:JSON.stringify(body)});

function fixture({token='session-jwt',authStatus=200,authBody={actorSubjectId:SUBJECT},
  providerStatus=200,providerBody=[{name:'PAY_BY_INSTALMENTS'}],
  providerResponse,providerError,timeoutMs=100}={}){
  const calls=[];
  const handler=createTamaraPreflight({supabaseUrl:SUPABASE,
    supabaseKey:'publishable-test-key',getAccessToken:async()=>token,timeoutMs,
    fetchImpl:async(url,init)=>{
      calls.push({url,init});
      if(url===RPC)return Response.json(authBody,{status:authStatus});
      if(providerError)throw providerError;
      if(providerResponse)return providerResponse;
      return Response.json(providerBody,{status:providerStatus});
    }
  });
  return {handler,calls};
}

test('unauthenticated and cross-origin callers cannot reach the provider',async()=>{
  const unsigned=fixture({token:null});
  assert.equal((await unsigned.handler(request())).status,401);
  assert.equal(unsigned.calls.length,0);
  for(const origin of ['https://attacker.test','null','https://odeir.com/']){
    const {handler,calls}=fixture();
    assert.equal((await handler(request(undefined,{origin}))).status,403);
    assert.equal(calls.length,0);
  }
  const cross=fixture();
  assert.equal((await cross.handler(request(undefined,{'sec-fetch-site':'cross-site'}))).status,403);
  assert.equal(cross.calls.length,0);
});

test('permission is verified with the user JWT before reading or forwarding keys',async()=>{
  for(const denied of [{authStatus:401},{authStatus:403},{authBody:{}},{authStatus:500}]){
    const {handler,calls}=fixture(denied);
    assert.ok([401,403,503].includes((await handler(request())).status));
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,RPC);
    assert.equal(calls[0].init.headers.Authorization,'Bearer session-jwt');
    assert.equal(calls[0].init.body,'{}');
    assert.ok(!JSON.stringify(calls[0]).includes(API_TOKEN));
  }
});

test('only the fixed environment endpoint receives API Token; no writes or card data',async()=>{
  for(const environment of ['sandbox','live']){
    const {handler,calls}=fixture();
    const response=await handler(request({environment,apiToken:API_TOKEN}));
    assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const body=await response.json();
    assert.equal(body.data.apiVerified,true);
    assert.equal(body.data.hasPaymentTypes,true);
    for(const field of ['liveReady','checkoutReady','notificationVerified','credentialsSaved']){
      assert.equal(body.data[field],false);
    }
    assert.equal(calls.length,2);
    assert.equal(calls[1].url,`https://${environment==='live'?'api':'api-sandbox'}.tamara.co/checkout/payment-types?country=SA&currency=SAR`);
    assert.equal(calls[1].init.method,'GET');
    assert.equal(calls[1].init.body,undefined);
    assert.equal(calls[1].init.redirect,'error');
    assert.equal(calls[1].init.cache,'no-store');
    assert.equal(calls[1].init.headers.Authorization,`Bearer ${API_TOKEN}`);
    assert.ok(!JSON.stringify(body).includes(API_TOKEN));
  }
});

test('rejects masked keys, unknown fields, mixed environments and malformed input',async()=>{
  for(const body of [null,[],{environment:'production',apiToken:API_TOKEN},
    {environment:['live'],apiToken:API_TOKEN},
    {environment:'sandbox',apiToken:'****'},
    {environment:'sandbox',apiToken:'secret-prefix...hidden-rest'},
    {environment:'sandbox',apiToken:API_TOKEN+'\r\nX-Injected: true'},
    {environment:'sandbox',apiToken:API_TOKEN,notificationToken:'never-forward'},
    {environment:'sandbox',apiToken:API_TOKEN,tenantId:'reef-skills'},
    {environment:'sandbox',apiToken:API_TOKEN,baseUrl:'https://attacker.test'}]){
    const {handler,calls}=fixture();
    assert.equal((await handler(request(body))).status,400);
    assert.equal(calls.length,1);
  }
});

test('supports documented payment_types envelope and empty method lists accurately',async()=>{
  for(const body of [{payment_types:[{name:'PAY_LATER'}]},[],{payment_types:[]}]){
    const {handler}=fixture({providerBody:body});
    const result=await (await handler(request())).json();
    assert.equal(result.data.apiVerified,true);
    assert.equal(result.data.paymentTypeCount,body.payment_types?.length||0);
    assert.equal(result.data.liveReady,false);
  }
});

test('unexpected provider responses cannot become a verified connection',async()=>{
  for(const providerBody of [{success:true},{error:'credential rejected'},
    [{name:''}],[null],{payment_types:'not-an-array'}]){
    const {handler}=fixture({providerBody});
    const response=await handler(request());
    assert.equal(response.status,502);
    assert.equal((await response.json()).success,false);
  }
});

test('provider failures do not reflect raw errors, headers or tokens',async()=>{
  for(const providerStatus of [401,403,404,429,500]){
    const {handler}=fixture({providerStatus,providerBody:{message:API_TOKEN}});
    const response=await handler(request());
    assert.equal(response.status,[401,403].includes(providerStatus)?422:503);
    assert.ok(!(await response.text()).includes(API_TOKEN));
  }
  const thrown=fixture({providerError:new Error(`failed ${API_TOKEN}`)});
  const response=await thrown.handler(request());
  assert.equal(response.status,503);
  assert.ok(!(await response.text()).includes(API_TOKEN));
});

test('limits request and upstream bodies including streams without content-length',async()=>{
  const oversized=fixture();
  assert.equal((await oversized.handler(request({environment:'sandbox',apiToken:'a'.repeat(14000)}))).status,413);
  assert.equal(oversized.calls.length,1);
  const big=fixture({providerResponse:Response.json([{name:'x'.repeat(70000)}])});
  assert.equal((await big.handler(request())).status,503);
  const html=fixture({providerResponse:new Response('<html>login</html>',{headers:{'content-type':'text/html'}})});
  assert.equal((await html.handler(request())).status,503);
});

test('a slow provider body is aborted within the same deadline as its headers',async()=>{
  let providerAborted=false;
  const handler=createTamaraPreflight({supabaseUrl:SUPABASE,supabaseKey:'pk',
    getAccessToken:async()=>'jwt',timeoutMs:20,
    fetchImpl:async(url,init)=>{
      if(url===RPC)return Response.json({actorSubjectId:SUBJECT});
      return new Response(new ReadableStream({start(controller){
        init.signal.addEventListener('abort',()=>{
          providerAborted=true;controller.error(new Error('aborted'));
        });
      }}),{headers:{'content-type':'application/json'}});
    }
  });
  assert.equal((await handler(request())).status,503);
  assert.equal(providerAborted,true);
});

test('Hostinger forwarded origin is restricted to the platform domain',async()=>{
  const headers={origin:'https://odeir.com','content-type':'application/json',
    'x-forwarded-host':'odeir.com','x-forwarded-proto':'https'};
  const req=()=>new Request('http://0.0.0.0:3000/api/platform/tamara-preflight',{
    method:'POST',headers,body:JSON.stringify({environment:'live',apiToken:API_TOKEN})
  });
  assert.equal((await fixture().handler(req())).status,200);
  headers['x-forwarded-host']='attacker.test';
  assert.equal((await fixture().handler(req())).status,403);
});
