import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  normalizedGraphVersion,
  randomHex,
  safeReturnUrl,
  sha256Hex,
  validReturnPath,
  verifySignedRequest
} from './security.mjs';

const MAX_BODY_BYTES=16*1024;
const REQUIRED_SCOPES=['ads_read'];
const ALLOWED_SCOPES=new Set(['ads_read','public_profile','email']);
const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, max-age=0',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; frame-ancestors 'none'"
};

type JsonRecord=Record<string,unknown>;
type OAuthContext={
  transactionId:string;
  tenantSlug:string;
  returnPath:string;
};

Deno.serve(async(request:Request)=>{
  const url=new URL(request.url);
  const route=routeName(url.pathname);
  if(request.method==='OPTIONS'&&['start','disconnect','complete'].includes(route)){
    const origin=allowedOrigin(request);
    if(!origin)return json(403,{ok:false,error:'origin_not_allowed'});
    return new Response(null,{status:204,headers:corsHeaders(origin)});
  }

  try{
    if(route==='health'&&request.method==='GET'){
      let configurationReady=false;
      try{runtimeConfig();configurationReady=true;}catch{/* No configuration values leave the server. */}
      return json(200,{ok:true,phase:'oauth_only',configurationReady,analyticsReady:false});
    }
    if(route==='start'&&request.method==='POST')return await startOAuth(request);
    if(route==='disconnect'&&request.method==='POST'){
      return await disconnect(request);
    }
    if(route==='complete'&&request.method==='POST'){
      return await completeOAuth(request);
    }
    if(route==='deauthorize'&&request.method==='POST'){
      return await processComplianceCallback(request,'deauthorization');
    }
    if(route==='data-deletion'&&request.method==='POST'){
      return await processComplianceCallback(request,'data_deletion');
    }
    if(route==='data-deletion/status'&&request.method==='GET'){
      return await deletionStatus(url);
    }
    return json(405,{ok:false,error:'method_not_allowed'});
  }catch(error){
    const code=publicError(error);
    console.error('[meta-oauth-v2]',code);
    return json(code==='service_unavailable'?503:400,{ok:false,error:code});
  }
});

async function startOAuth(request:Request){
  const config=runtimeConfig();
  const origin=allowedOrigin(request);
  if(request.headers.has('origin')&&!origin){
    return json(403,{ok:false,error:'origin_not_allowed'});
  }
  const authorization=request.headers.get('authorization')||'';
  if(!authorization.startsWith('Bearer ')){
    return json(401,{ok:false,error:'authentication_required'},origin);
  }
  const body=await boundedJson(request);
  const tenantSlug=clean(body.tenantSlug,80);
  const returnPath=clean(body.returnPath,500);
  if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(tenantSlug)
     ||!validReturnPath(returnPath)){
    return json(400,{ok:false,error:'invalid_oauth_request'},origin);
  }

  const state=randomHex(32);
  const stateHash=await sha256Hex(state);
  await userRpc('v1_tenant_meta_connect_v2_begin_oauth',authorization,{
    p_tenant_slug:tenantSlug,
    p_state_sha256:stateHash,
    p_return_path:returnPath
  });

  const authorizeUrl=new URL(
    `https://www.facebook.com/${config.graphVersion}/dialog/oauth`
  );
  authorizeUrl.searchParams.set('client_id',config.appId);
  authorizeUrl.searchParams.set('redirect_uri',config.callbackUrl);
  authorizeUrl.searchParams.set('state',state);
  authorizeUrl.searchParams.set('config_id',config.loginConfigId);
  authorizeUrl.searchParams.set('response_type','code');
  authorizeUrl.searchParams.set('override_default_response_type','true');
  return json(200,{
    ok:true,
    authorizeUrl:authorizeUrl.toString(),
    expiresIn:600
  },origin);
}

async function disconnect(request:Request){
  runtimeConfig();
  const origin=allowedOrigin(request);
  if(request.headers.has('origin')&&!origin){
    return json(403,{ok:false,error:'origin_not_allowed'});
  }
  const authorization=request.headers.get('authorization')||'';
  if(!authorization.startsWith('Bearer ')){
    return json(401,{ok:false,error:'authentication_required'},origin);
  }
  const body=await boundedJson(request);
  const tenantSlug=clean(body.tenantSlug,80);
  if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(tenantSlug)){
    return json(400,{ok:false,error:'invalid_tenant'},origin);
  }
  const result=await userRpc<JsonRecord>(
    'v1_tenant_meta_connect_v2_disconnect',authorization,
    {p_tenant_slug:tenantSlug}
  );
  return json(200,{ok:true,status:result.status},origin);
}

async function completeOAuth(request:Request){
  const config=runtimeConfig();
  const authorization=request.headers.get('authorization')||'';
  if(!authorization.startsWith('Bearer '))return json(401,{ok:false,error:'authentication_required'});
  const body=await boundedJson(request);
  const state=clean(body.state,128);
  if(!/^[a-f0-9]{64}$/.test(state)){
    throw new PublicError('oauth_state_invalid');
  }

  let context:OAuthContext|undefined;
  try{
    context=await userRpc<OAuthContext>(
      'v1_tenant_meta_connect_v2_claim_oauth',authorization,
      {p_state_sha256:await sha256Hex(state)}
    );
    if(!context?.transactionId||!validReturnPath(context.returnPath)){
      throw new PublicError('oauth_state_invalid');
    }
    if(body.cancelled===true){
      return completion(context.returnPath,{
        social_connect:'cancelled'
      });
    }

    const code=clean(body.code,4096);
    if(!code)throw new PublicError('oauth_code_missing');
    const token=await exchangeCode(code,config);
    const debug=await inspectToken(token.accessToken,config);
    const scopes=Array.from(new Set(debug.scopes)).sort();
    const missingScopes=REQUIRED_SCOPES.filter(scope=>!scopes.includes(scope));
    if(missingScopes.length)throw new PublicError('required_scopes_missing');
    if(scopes.some(scope=>!ALLOWED_SCOPES.has(scope))){
      throw new PublicError('excessive_scopes_granted');
    }

    await serviceRpc('v1_service_meta_connect_v2_finalize_oauth',{
      p_transaction_id:context.transactionId,
      p_external_user_id:debug.userId,
      p_external_user_sha256:await sha256Hex(`${debug.userId}|${config.appId}`),
      p_access_token:token.accessToken,
      p_granted_scopes:scopes,
      p_token_expires_at:unixTimeOrNull(
        debug.expiresAt||token.expiresAt
      ),
      p_data_access_expires_at:unixTimeOrNull(debug.dataAccessExpiresAt)
    });
    return completion(context.returnPath,{
      social_connect:'connected'
    });
  }catch(error){
    const code=publicError(error);
    console.error('[meta-oauth-v2:callback]',code);
    if(context?.returnPath){
      return completion(context.returnPath,{
        social_connect:'error',reason:code
      });
    }
    return json(400,{ok:false,error:code});
  }
}

async function exchangeCode(code:string,config:RuntimeConfig){
  const endpoint=new URL(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token`
  );
  const form=new URLSearchParams({client_id:config.appId,client_secret:config.appSecret,
    redirect_uri:config.callbackUrl,code});
  endpoint.search=form.toString();
  // Meta documents this exchange as GET. Never log this URL, its query, or the
  // response payload; only sanitized operation/error codes leave this boundary.
  const response=await fetch(endpoint,{cache:'no-store',
    signal:AbortSignal.timeout(10_000),redirect:'error'});
  const payload=await response.json().catch(()=>({})) as JsonRecord;
  const accessToken=clean(payload.access_token,8192);
  if(!response.ok||accessToken.length<32){
    throw new PublicError('oauth_exchange_failed');
  }
  const expiresIn=Number(payload.expires_in||0);
  // User tokens must be exchanged once for a long-lived grant to avoid asking
  // the manager to reconnect after a short session token expires.
  const longForm=new URLSearchParams({grant_type:'fb_exchange_token',
    client_id:config.appId,client_secret:config.appSecret,fb_exchange_token:accessToken});
  endpoint.search=longForm.toString();
  const longResponse=await fetch(endpoint,{cache:'no-store',
    signal:AbortSignal.timeout(10_000),redirect:'error'});
  const longPayload=await longResponse.json().catch(()=>({})) as JsonRecord;
  const longToken=clean(longPayload.access_token,8192);
  if(!longResponse.ok||longToken.length<32)throw new PublicError('oauth_exchange_failed');
  const longExpires=Number(longPayload.expires_in||expiresIn);
  return {accessToken:longToken,expiresAt:Number.isFinite(longExpires)&&longExpires>0
    ?Math.floor(Date.now()/1000)+longExpires:0};
}

async function inspectToken(accessToken:string,config:RuntimeConfig){
  const endpoint=new URL(
    `https://graph.facebook.com/${config.graphVersion}/debug_token`
  );
  endpoint.searchParams.set('input_token',accessToken);
  const response=await fetch(endpoint,{headers:{authorization:`Bearer ${config.appId}|${config.appSecret}`},
    cache:'no-store',signal:AbortSignal.timeout(10_000),redirect:'error'});
  const payload=await response.json().catch(()=>({})) as {
    data?:Record<string,unknown>
  };
  const data=payload.data||{};
  const appId=String(data.app_id||'');
  const userId=clean(data.user_id,120);
  const scopes=Array.isArray(data.scopes)
    ?data.scopes.map(scope=>String(scope)).filter(scope=>scope.length<=120)
    :[];
  if(!response.ok||data.is_valid!==true||appId!==config.appId||data.type!=='USER'
     ||(Number(data.expires_at)>0&&Number(data.expires_at)<=Date.now()/1000)
     ||(Number(data.data_access_expires_at)>0&&Number(data.data_access_expires_at)<=Date.now()/1000)
     ||!/^[A-Za-z0-9_-]{1,120}$/.test(userId)){
    throw new PublicError('oauth_token_invalid');
  }
  return {
    userId,
    scopes,
    expiresAt:Number(data.expires_at||0),
    dataAccessExpiresAt:Number(data.data_access_expires_at||0)
  };
}

async function processComplianceCallback(
  request:Request,
  eventType:'deauthorization'|'data_deletion'
){
  const config=runtimeConfig();
  const body=await boundedText(request);
  const form=new URLSearchParams(body);
  const signedRequest=clean(form.get('signed_request'),16_000);
  const verified=await verifySignedRequest(signedRequest,config.appSecret,{
    maxAgeSeconds:900
  });
  const payloadHash=await sha256Hex(signedRequest);
  const externalUserHash=await sha256Hex(
    `${verified.userId}|${config.appId}`
  );

  if(eventType==='data_deletion'){
    // Deterministic per signed callback so a provider retry receives the same
    // public code while only its SHA-256 digest is persisted in Postgres.
    const confirmationCode=(await sha256Hex(
      `${signedRequest}|${config.appSecret}|data-deletion-confirmation`
    )).slice(0,48);
    const result=await serviceRpc<JsonRecord>(
      'v1_service_meta_connect_v2_process_callback',{
        p_event_type:eventType,
        p_external_user_id:verified.userId,
        p_external_user_sha256:externalUserHash,
        p_issued_at:new Date(verified.issuedAt*1000).toISOString(),
        p_payload_sha256:payloadHash,
        p_confirmation_sha256:await sha256Hex(confirmationCode)
      }
    );
    return json(200,{
      url:safeReturnUrl(config.returnOrigin,'/data-deletion',{
        code:confirmationCode
      }),
      confirmation_code:confirmationCode,
      status:result.status
    });
  }

  const result=await serviceRpc<JsonRecord>(
    'v1_service_meta_connect_v2_process_callback',{
      p_event_type:eventType,
      p_external_user_id:verified.userId,
      p_external_user_sha256:externalUserHash,
      p_issued_at:new Date(verified.issuedAt*1000).toISOString(),
      p_payload_sha256:payloadHash,
      p_confirmation_sha256:null
    }
  );
  return json(200,{success:true,status:result.status});
}

async function deletionStatus(url:URL){
  runtimeConfig();
  const code=clean(url.searchParams.get('code'),128);
  if(!/^[a-f0-9]{48}$/.test(code)){
    return json(404,{ok:false,status:'not_found'});
  }
  const result=await serviceRpc<JsonRecord>(
    'v1_service_meta_connect_v2_deletion_status',{
      p_confirmation_sha256:await sha256Hex(code)
    }
  );
  return json(result.status==='not_found'?404:200,{ok:true,...result});
}

type RuntimeConfig={
  supabaseUrl:string;
  anonKey:string;
  serviceRoleKey:string;
  appId:string;
  appSecret:string;
  loginConfigId:string;
  graphVersion:string;
  returnOrigin:string;
  callbackUrl:string;
};

function runtimeConfig():RuntimeConfig{
  const supabaseUrl=clean(Deno.env.get('SUPABASE_URL'),500).replace(/\/$/,'');
  const anonKey=clean(Deno.env.get('SUPABASE_ANON_KEY'),4096);
  const serviceRoleKey=clean(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),4096);
  const appId=clean(Deno.env.get('META_CONNECT_V2_APP_ID'),40);
  const appSecret=clean(Deno.env.get('META_CONNECT_V2_APP_SECRET'),512);
  const loginConfigId=clean(
    Deno.env.get('META_CONNECT_V2_LOGIN_CONFIG_ID'),40
  );
  const graphVersion=normalizedGraphVersion(
    Deno.env.get('META_CONNECT_V2_GRAPH_VERSION')
  );
  const returnOrigin=clean(
    Deno.env.get('META_CONNECT_V2_RETURN_ORIGIN'),500
  ).replace(/\/$/,'');
  if(
    !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(supabaseUrl)
    ||anonKey.length<20
    ||serviceRoleKey.length<20
    ||!/^[0-9]{5,40}$/.test(appId)
    ||appSecret.length<16
    ||!/^[0-9]{5,40}$/.test(loginConfigId)
  )throw new PublicError('service_unavailable');
  safeReturnUrl(returnOrigin,'/');
  return {
    supabaseUrl,anonKey,serviceRoleKey,appId,appSecret,loginConfigId,
    graphVersion,returnOrigin,
    callbackUrl:`${returnOrigin}/api/tenant/social-connect/callback`
  };
}

async function userRpc<T=JsonRecord>(
  name:string,authorization:string,body:JsonRecord
):Promise<T>{
  const config=runtimeConfig();
  return callRpc<T>(name,body,{
    apikey:config.anonKey,authorization
  });
}

async function serviceRpc<T=JsonRecord>(
  name:string,body:JsonRecord
):Promise<T>{
  const config=runtimeConfig();
  return callRpc<T>(name,body,{
    apikey:config.serviceRoleKey,
    authorization:`Bearer ${config.serviceRoleKey}`
  });
}

async function callRpc<T>(
  name:string,body:JsonRecord,credentials:Record<string,string>
):Promise<T>{
  const config=runtimeConfig();
  const response=await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{...credentials,'content-type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(8_000)
  });
  if(!response.ok){
    const payload=await response.json().catch(()=>({})) as JsonRecord;
    const message=clean(payload.message,160);
    throw new PublicError(databasePublicCode(message));
  }
  return await response.json() as T;
}

async function boundedJson(request:Request):Promise<JsonRecord>{
  const raw=await boundedText(request);
  try{
    const body=JSON.parse(raw);
    if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();
    return body;
  }catch{
    throw new PublicError('invalid_json');
  }
}

async function boundedText(request:Request){
  const declared=Number(request.headers.get('content-length')||0);
  if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES){
    throw new PublicError('payload_too_large');
  }
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>MAX_BODY_BYTES){
    throw new PublicError('payload_too_large');
  }
  return raw;
}

function routeName(pathname:string){
  const marker='/meta-oauth-v2/';
  const index=pathname.indexOf(marker);
  return index>=0?pathname.slice(index+marker.length).replace(/\/$/,''):'';
}

function allowedOrigin(request:Request){
  const origin=clean(request.headers.get('origin'),500).replace(/\/$/,'');
  const configured=clean(
    Deno.env.get('META_CONNECT_V2_RETURN_ORIGIN'),500
  ).replace(/\/$/,'');
  return origin&&configured&&origin===configured?origin:'';
}

function corsHeaders(origin:string){
  return {
    ...JSON_HEADERS,
    'access-control-allow-origin':origin,
    'access-control-allow-methods':'POST, OPTIONS',
    'access-control-allow-headers':'authorization, apikey, content-type',
    'access-control-max-age':'600',
    'vary':'Origin'
  };
}

function json(
  status:number,body:JsonRecord,corsOrigin=''
){
  return new Response(JSON.stringify(body),{
    status,
    headers:{...JSON_HEADERS,...(corsOrigin?corsHeaders(corsOrigin):{})}
  });
}

function completion(path:string,params:Record<string,string>){
  const url=new URL(safeReturnUrl(runtimeConfig().returnOrigin,path,params));
  return json(200,{ok:true,returnPath:url.pathname+url.search});
}

function unixTimeOrNull(value:number){
  return Number.isFinite(value)&&value>0
    ?new Date(value*1000).toISOString()
    :null;
}

function clean(value:unknown,maxLength:number){
  return typeof value==='string'?value.trim().slice(0,maxLength):'';
}

function databasePublicCode(message:string){
  const allowed=new Set([
    'tenant_not_found','forbidden','addon_not_enabled',
    'meta_connect_v2_not_in_rollout','meta_connect_v2_oauth_disabled',
    'meta_connect_v2_callback_disabled','legacy_meta_connection_present',
    'oauth_state_invalid_or_used','invalid_oauth_request'
  ]);
  return allowed.has(message)?message:'service_unavailable';
}

function publicError(error:unknown){
  if(error instanceof PublicError)return error.code;
  if(error instanceof Error&&[
    'signed_request_invalid','invalid_return_path','invalid_return_origin',
    'invalid_graph_version'
  ].includes(error.message))return error.message;
  return 'service_unavailable';
}

class PublicError extends Error{
  constructor(readonly code:string){super(code);}
}
