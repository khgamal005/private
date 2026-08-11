import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MAX_BODY_BYTES=16*1024;
const PROVIDERS=new Set(['tamara','paymob','paypal']);
const PUBLIC_CONFIG_KEYS=new Set([
  'merchantId','merchantAccountId','integrationId','webhookId'
]);
const SUBJECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST')return json(405,{ok:false,error:'method_not_allowed'});
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
    const authorizationCheck=await fetch(
      `${supabaseUrl}/rest/v1/rpc/v3_platform_payment_provider_admin_snapshot`,
      {
        method:'POST',
        headers:{
          apikey:anonKey,
          authorization,
          'content-type':'application/json'
        },
        body:'{}'
      }
    );
    if(!authorizationCheck.ok)return json(403,{ok:false,error:'forbidden'});
    const authorizationContext=await authorizationCheck.json() as {
      actorSubjectId?:unknown
    };
    const actorSubjectId=String(authorizationContext.actorSubjectId||'');
    if(!SUBJECT_ID.test(actorSubjectId)){
      return json(403,{ok:false,error:'platform_subject_not_found'});
    }

    const rawBody=await request.text();
    if(new TextEncoder().encode(rawBody).byteLength>MAX_BODY_BYTES){
      return json(413,{ok:false,error:'payload_too_large'});
    }
    const payload=JSON.parse(rawBody) as Record<string,unknown>;
    const providerKey=String(payload.providerKey||'');
    const environment=String(payload.environment||'');
    const checkoutMode=String(payload.checkoutMode||'');
    const supportedCurrencies=Array.isArray(payload.supportedCurrencies)
      ?payload.supportedCurrencies.map(value=>String(value).toUpperCase())
      :[];
    const secrets=payload.secrets&&typeof payload.secrets==='object'
      &&!Array.isArray(payload.secrets)
      ?payload.secrets as Record<string,unknown>
      :{};
    const publicConfig=payload.publicConfig
      &&typeof payload.publicConfig==='object'
      &&!Array.isArray(payload.publicConfig)
      ?payload.publicConfig as Record<string,unknown>
      :{};
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
         ||typeof value!=='string'
         ||value.trim().length<1
         ||value.length>240
         ||/[\u0000-\u001f\u007f]/.test(value)
       )){
      return json(400,{ok:false,error:'invalid_credentials_payload'});
    }

    const stored=await fetch(
      `${supabaseUrl}/rest/v1/rpc/v3_service_payment_provider_bundle_action`,
      {
        method:'POST',
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
      }
    );
    if(!stored.ok){
      console.warn('[payment-provider-admin] credential store rejected',stored.status);
      return json(400,{ok:false,error:'credential_store_rejected'});
    }
    const result=await stored.json();
    return json(200,{
      ok:true,
      providerKey,
      status:result?.status,
      configured:Boolean(result?.configured),
      secretReturned:false
    });
  }catch(error){
    console.error(
      '[payment-provider-admin] unexpected failure',
      error instanceof Error?error.name:'unknown_error'
    );
    return json(500,{ok:false,error:'internal_error'});
  }
});
