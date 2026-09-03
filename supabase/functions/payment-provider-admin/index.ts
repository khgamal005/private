import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MAX_BODY_BYTES=16*1024;
const MAX_RPC_RESPONSE_BYTES=16*1024;
const RPC_TIMEOUT_MS=10_000;
const PROVIDERS=new Set(['tamara','paymob','paypal']);
const PUBLIC_CONFIG_KEYS=new Set([
  'merchantId','merchantAccountId','integrationId','applePayIntegrationId',
  'integrationPath','webhookId','region'
]);
const PAYMOB_PUBLIC_CONFIG_KEYS=new Set([
  'merchantAccountId','integrationPath','integrationId',
  'applePayIntegrationId','region'
]);
const PAYMOB_SECRET_KEYS=new Set([
  'secretKey','publicKey','hmacSecret','apiKey'
]);
const SUBJECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class UpstreamTimeoutError extends Error{
  constructor(){
    super('upstream_timeout');
    this.name='UpstreamTimeoutError';
  }
}

function positiveSafeInteger(value:unknown){
  if(typeof value!=='string'||!/^[1-9]\d*$/.test(value))return false;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>0;
}

function validProviderConfig(
  providerKey:string,
  checkoutMode:string,
  supportedCurrencies:string[],
  publicConfig:Record<string,unknown>,
  secretEntries:[string,unknown][]
){
  if(providerKey!=='paymob')return true;
  const configKeys=Object.keys(publicConfig);
  const integrationPath=publicConfig.integrationPath;
  const applePayIntegrationId=publicConfig.applePayIntegrationId;
  return checkoutMode==='redirect'
    &&supportedCurrencies.length===1
    &&supportedCurrencies[0]==='SAR'
    &&configKeys.every(key=>PAYMOB_PUBLIC_CONFIG_KEYS.has(key))
    &&positiveSafeInteger(publicConfig.merchantAccountId)
    &&positiveSafeInteger(publicConfig.integrationId)
    &&(integrationPath==='intention'||integrationPath==='quicklink')
    &&Object.prototype.hasOwnProperty.call(
      publicConfig,'applePayIntegrationId'
    )
    &&(applePayIntegrationId===null||(
      integrationPath==='quicklink'
      &&positiveSafeInteger(applePayIntegrationId)
      &&applePayIntegrationId!==publicConfig.integrationId
    ))
    &&publicConfig.region==='ksa'
    &&secretEntries.every(([key])=>PAYMOB_SECRET_KEYS.has(key));
}

function json(status:number,body:Record<string,unknown>){
  return new Response(JSON.stringify(body),{
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff'
    }
  });
}

async function readTextLimited(
  request:{body:ReadableStream<Uint8Array>|null},
  maxBytes:number
):Promise<{text:string;tooLarge:boolean}>{
  if(!request.body)return {text:'',tooLarge:false};
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel('request_body_too_large').catch(()=>{});
        return {text:'',tooLarge:true};
      }
      chunks.push(value);
    }
  }finally{
    reader.releaseLock();
  }
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){
    bytes.set(chunk,offset);
    offset+=chunk.byteLength;
  }
  return {
    text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),
    tooLarge:false
  };
}

async function fetchTextWithTimeout(
  input:string,
  init:RequestInit,
  timeoutMs:number,
  maxBytes:number
):Promise<{response:Response;text:string}>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(input,{...init,signal:controller.signal});
    const result=await readTextLimited(response,maxBytes);
    if(result.tooLarge)throw new Error('upstream_response_too_large');
    return {response,text:result.text};
  }catch(error){
    if(controller.signal.aborted)throw new UpstreamTimeoutError();
    throw error;
  }finally{
    clearTimeout(timer);
  }
}

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST')return json(405,{ok:false,error:'method_not_allowed'});
  const contentType=(request.headers.get('content-type')||'')
    .split(';',1)[0].trim().toLowerCase();
  if(contentType!=='application/json'){
    return json(415,{ok:false,error:'unsupported_media_type'});
  }
  const authorization=request.headers.get('authorization')||'';
  const supabaseUrl=Deno.env.get('SUPABASE_URL');
  const anonKey=Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!authorization.startsWith('Bearer ')||!supabaseUrl||!anonKey||!serviceRoleKey){
    return json(401,{ok:false,error:'unauthorized'});
  }
  const declaredLength=Number(request.headers.get('content-length')||0);
  if(Number.isFinite(declaredLength)&&declaredLength>MAX_BODY_BYTES){
    return json(413,{ok:false,error:'payload_too_large'});
  }

  try{
    // Authorize with the caller's own JWT. The RPC performs the canonical
    // platform.billing.manage check and returns no credentials.
    const authorizationResult=await fetchTextWithTimeout(
      `${supabaseUrl}/rest/v1/rpc/v3_platform_payment_provider_admin_snapshot`,
      {
        method:'POST',
        redirect:'error',
        headers:{
          apikey:anonKey,
          authorization,
          'content-type':'application/json'
        },
        body:'{}'
      },
      RPC_TIMEOUT_MS,
      MAX_RPC_RESPONSE_BYTES
    );
    const authorizationCheck=authorizationResult.response;
    if(!authorizationCheck.ok)return json(403,{ok:false,error:'forbidden'});
    const authorizationContext=JSON.parse(authorizationResult.text) as {
      actorSubjectId?:unknown
    };
    const actorSubjectId=String(authorizationContext.actorSubjectId||'');
    if(!SUBJECT_ID.test(actorSubjectId)){
      return json(403,{ok:false,error:'platform_subject_not_found'});
    }

    const {text:rawBody,tooLarge}=await readTextLimited(
      request,MAX_BODY_BYTES
    );
    if(tooLarge){
      return json(413,{ok:false,error:'payload_too_large'});
    }
    const payload=JSON.parse(rawBody) as Record<string,unknown>;
    const providerKey=String(payload.providerKey||'');
    const environment=String(payload.environment||'');
    const checkoutMode=String(payload.checkoutMode||'');
    const supportedCurrencies=Array.isArray(payload.supportedCurrencies)
      ?payload.supportedCurrencies.map(value=>String(value).trim().toUpperCase())
      :[];
    const secrets=payload.secrets&&typeof payload.secrets==='object'
      &&!Array.isArray(payload.secrets)
      ?payload.secrets as Record<string,unknown>
      :{};
    const submittedPublicConfig=payload.publicConfig
      &&typeof payload.publicConfig==='object'
      &&!Array.isArray(payload.publicConfig)
      ?payload.publicConfig as Record<string,unknown>
      :{};
    const publicConfig=Object.fromEntries(
      Object.entries(submittedPublicConfig).map(([key,value])=>[
        key,typeof value==='string'?value.trim():value
      ])
    );
    const secretEntries=Object.entries(secrets);
    const publicConfigEntries=Object.entries(publicConfig);
    if(!PROVIDERS.has(providerKey)
       ||!['sandbox','live'].includes(environment)
       ||!['redirect','embedded','api'].includes(checkoutMode)
       ||supportedCurrencies.length<1
       ||supportedCurrencies.length>20
       ||supportedCurrencies.some(value=>!/^[A-Z]{3}$/.test(value))
       ||secretEntries.length>20
       ||secretEntries.some(([key,value])=>
         !/^[a-z][A-Za-z0-9]{1,80}$/.test(key)
         ||typeof value!=='string'
         ||value.length<1
         ||value.length>8192
       )
       ||publicConfigEntries.length>10
       ||publicConfigEntries.some(([key,value])=>
         !PUBLIC_CONFIG_KEYS.has(key)
         ||(key==='applePayIntegrationId'&&value===null
           ?false
           :typeof value!=='string'
             ||value.trim().length<1
             ||value.length>240
             ||/[\u0000-\u001f\u007f]/.test(value))
       )
       ||!validProviderConfig(
         providerKey,checkoutMode,supportedCurrencies,publicConfig,secretEntries
       )){
      return json(400,{ok:false,error:'invalid_credentials_payload'});
    }

    const storedResult=await fetchTextWithTimeout(
      `${supabaseUrl}/rest/v1/rpc/v3_service_payment_provider_bundle_action`,
      {
        method:'POST',
        redirect:'error',
        headers:{
          apikey:serviceRoleKey,
          authorization:`Bearer ${serviceRoleKey}`,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          p_provider_key:providerKey,
          p_environment:environment,
          p_checkout_mode:checkoutMode,
          p_supported_currencies:supportedCurrencies,
          p_enabled:payload.enabled!==false,
          p_public_config:publicConfig,
          p_secrets:secrets,
          p_actor_subject_id:actorSubjectId
        })
      },
      RPC_TIMEOUT_MS,
      MAX_RPC_RESPONSE_BYTES
    );
    const stored=storedResult.response;
    if(!stored.ok){
      console.warn('[payment-provider-admin] credential store rejected',stored.status);
      return json(400,{ok:false,error:'credential_store_rejected'});
    }
    const result=JSON.parse(storedResult.text);
    return json(200,{
      ok:true,
      providerKey,
      status:result?.status,
      configured:Boolean(result?.configured),
      liveReady:false,
      secretReturned:false
    });
  }catch(error){
    console.error(
      '[payment-provider-admin] unexpected failure',
      error instanceof Error?error.name:'unknown_error'
    );
    return json(error instanceof UpstreamTimeoutError?503:500,{
      ok:false,
      error:error instanceof UpstreamTimeoutError
        ?'upstream_timeout'
        :'internal_error'
    });
  }
});
