import {handleGA4} from './ga4-handler.mjs';
// Injectable orchestration: every Google request follows a tenant-authorized RPC.
// Provider credentials exist only in this server and the Vault-backed service RPCs.
const USER='v1_tenant_google_ads_';
const SERVICE='v1_service_google_ads_';
const SCOPE='https://www.googleapis.com/auth/adwords';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTES=new Set(['start','complete','assets','select','sync','disconnect','sources','review','ga4-status','ga4-assets','ga4-select','ga4-sync','ga4-report','ga4-disable']);
const ERROR_ALIASES={
  google_ads_reporting_only:'reporting_only',google_ads_forbidden:'forbidden',google_ads_protected_tenant:'protected_tenant',google_ads_tenant_not_found:'forbidden',
  google_ads_not_enabled:'addon_not_enabled',google_ads_oauth_invalid:'oauth_state_invalid_or_used',google_ads_oauth_stale:'oauth_state_invalid_or_used',
  google_ads_invalid_oauth:'oauth_state_invalid',google_ads_no_eligible_accounts:'no_eligible_ads_accounts',
  google_ads_account_not_discovered:'account_not_available',google_ads_connection_required:'reauth_required',
  google_ads_credential_missing:'reauth_required',google_ads_range_invalid:'invalid_date_range',
  google_ads_preview_stale:'preview_stale',google_ads_source_changed_refresh_preview:'preview_stale',google_ads_sync_in_progress:'sync_in_progress',
  google_ads_stale_lease:'request_rejected',google_ads_command_reused:'request_rejected',
  google_reconnect_required:'reauth_required',google_access_denied:'google_access_denied',
  google_customer_not_enabled:'ads_account_inactive',
  google_cloud_project_access_required:'platform_access_required',google_ads_user_required:'no_eligible_ads_accounts',
  google_rate_limited:'rate_limited',google_oauth_configuration_invalid:'configuration_missing',
  google_scope_missing:'required_scopes_missing',google_date_range_invalid:'invalid_date_range',
  google_date_invalid:'invalid_date_range',google_date_future:'invalid_date_range',
  google_account_mismatch:'account_not_available',google_advertiser_account_required:'account_not_available',
  google_request_aborted:'service_unavailable',google_request_timeout:'service_unavailable',google_network_error:'service_unavailable'
};
const SAFE_ERRORS=new Set(['ga4_consent_required','ga4_access_denied','ga4_request_failed','ga4_invalid_response','ga4_invalid_property','ga4_invalid_store','ga4_store_mismatch','ga4_property_changed','ga4_result_limit','ga4_report_changed','ga4_incomplete_report','ga4_not_configured','reporting_only','authentication_required','forbidden','protected_tenant','addon_not_enabled','configuration_missing',
  'reauth_required','oauth_state_invalid','oauth_state_invalid_or_used','required_scopes_missing','account_not_available',
  'preview_stale','invalid_date_range','rate_limited','service_unavailable','sync_in_progress','sync_failed',
  'request_rejected','invalid_request','payload_too_large','not_found',
  'no_eligible_ads_accounts','ads_account_inactive','google_access_denied','platform_access_required','google_api_not_enabled',
  'google_oauth_exchange_failed','google_accounts_unavailable','google_connection_save_failed']);
export function publicError(error){
  const code=typeof error==='string'?error:error?.code||error?.message;
  return Object.hasOwn(ERROR_ALIASES,code)?ERROR_ALIASES[code]:(SAFE_ERRORS.has(code)?code:'request_rejected');
}
function fail(code){throw Object.assign(new Error(code),{code});}
export async function boundedJson(request){
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')fail('invalid_request');
  const limit=64*1024;
  if(Number(request.headers.get('content-length'))>limit)fail('payload_too_large');
  const reader=request.body?.getReader();
  if(!reader)fail('invalid_request');
  const chunks=[];
  let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();fail('payload_too_large');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_request');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_request');
  return value;
}
async function hash(value,encoding='hex'){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return encoding==='hex'?Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
    :btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function slug(value){
  if(value==='reefskills')fail('protected_tenant');
  if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(value))fail('invalid_request');
  return value;
}
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0',
  'referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"
}});}
function dateRange(from,to){
  const parse=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('invalid_date_range');
    const time=Date.parse(value+'T00:00:00Z');
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail('invalid_date_range');
    return time;
  };
  const days=(parse(to)-parse(from))/86400000;
  if(days<0||days>30)fail('invalid_date_range');
}

export function createGoogleAdsHandler({env,createClient,fetchImpl=fetch,
  logFailure=event=>console.warn('google_ads_oauth_failure',JSON.stringify(event))}){
  const value=key=>typeof env==='function'?env(key):env[key];
  function client(signal){
    const config={clientId:value('GOOGLE_ADS_CLIENT_ID'),clientSecret:value('GOOGLE_ADS_CLIENT_SECRET'),
      developerToken:value('GOOGLE_ADS_DEVELOPER_TOKEN'),redirectUri:value('GOOGLE_ADS_REDIRECT_URI'),
      apiVersion:value('GOOGLE_ADS_API_VERSION')||'v25'};
    if(!config.clientId||!config.clientSecret||!config.redirectUri)fail('configuration_missing');
    if(!['https://odeir.com/api/tenant/google-ads/callback','https://staging.odeir.com/api/tenant/google-ads/callback'].includes(config.redirectUri))fail('configuration_missing');
    return createClient(config,{fetchImpl,signal,timeoutMs:15000,maxRetries:2,maxPages:10,maxAccounts:100});
  }
  async function rpc(name,args,authorization,signal,service=false){
    const root=value('SUPABASE_URL');
    const key=value(service?'SUPABASE_SERVICE_ROLE_KEY':'SUPABASE_ANON_KEY');
    if(!root||!key)fail('configuration_missing');
    const response=await fetchImpl(`${root}/rest/v1/rpc/${name}`,{method:'POST',
      headers:{apikey:key,authorization:service?`Bearer ${key}`:authorization,'content-type':'application/json'},
      body:JSON.stringify(args),signal});
    const result=await response.json().catch(()=>null);
    if(!response.ok){
      if(response.status===401)fail('authentication_required');
      if(response.status===403)fail('forbidden');
      fail(publicError(result?.message));
    }
    if(!result||typeof result!=='object'||Array.isArray(result))fail('service_unavailable');
    return result;
  }
  return async function handle(request){
    const route=new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    if(!ROUTES.has(route))return json({ok:false,error:'not_found'},404);
    if(request.method!=='POST')return json({ok:false,error:'invalid_request'},405);
    const authorization=request.headers.get('authorization')||'';
    if(!/^Bearer [^\s]+$/.test(authorization))return json({ok:false,error:'authentication_required'},401);
    const origin=request.headers.get('origin');
    if(origin&&!['https://odeir.com','https://staging.odeir.com'].includes(origin))return json({ok:false,error:'forbidden'},403);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout((route==='sync'||route==='ga4-sync')?130000:55000)]);
    const user=(suffix,args)=>rpc(USER+suffix,args,authorization,signal);
    const service=(suffix,args)=>rpc(SERVICE+suffix,args,authorization,signal,true);
    let callback=null;
    try{
      const body=await boundedJson(request);
      if(route==='complete'){
        if(!/^[a-f0-9]{64}$/.test(body.state||'')||typeof body.codeVerifier!=='string'
          ||!/^[A-Za-z0-9_-]{43,128}$/.test(body.codeVerifier))fail('oauth_state_invalid');
        // Claim consumes state and rechecks the saved user, PKCE and tenant before exchange.
        const context=await user('claim_oauth',{p_state_sha256:await hash(body.state),p_pkce_challenge:await hash(body.codeVerifier,'base64url')});
        const tenantSlug=slug(context.tenantSlug);
        const returnPath=`/tenant/${tenantSlug}/reports/google-ads`;
        if(context.returnPath!==returnPath||!UUID.test(context.transactionId))fail('oauth_state_invalid');
        callback={returnPath,transactionId:context.transactionId,stage:'authorization'};
        if(body.cancelled===true)return json({ok:true,returnPath:returnPath+'?google_ads=cancelled'});
        if(typeof body.code!=='string'||!body.code||body.code.length>8192)fail('oauth_state_invalid');
        const google=client(signal);
        callback.stage='token_exchange';
        const tokens=await google.exchangeCode({code:body.code,codeVerifier:body.codeVerifier,signal});
        if(!tokens.refreshToken)fail('reauth_required');
        const scopes=String(tokens.scope||'').split(/\s+/).filter(Boolean);
        if(!scopes.includes(SCOPE))fail('required_scopes_missing');
        callback.stage='account_discovery';
        const discovered=await google.discoverAccounts({accessToken:tokens.accessToken,signal});
        if(discovered.truncated!==false||!Array.isArray(discovered.accounts))fail('account_not_available');
        callback.stage='connection_save';
        await service('finalize_oauth',{p_transaction_id:context.transactionId,p_refresh_token:tokens.refreshToken,
          p_accounts:discovered.accounts,p_scopes:scopes});
        return json({ok:true,returnPath:returnPath+'?google_ads=connected'});
      }
      const tenantSlug=slug(body.tenantSlug);
      // The user-approved Reef pilot never performs CRM source matching.
      if(tenantSlug==='reef-skills'&&['sources','review'].includes(route))fail('reporting_only');
      if(route==='start'){
        if(!/^[a-f0-9]{64}$/.test(body.state||'')||!/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge||'')
          ||body.returnPath!==`/tenant/${tenantSlug}/reports/google-ads`)fail('invalid_request');
        const google=client(signal);
        await user('begin_oauth',{p_slug:tenantSlug,p_state_sha256:await hash(body.state),p_pkce_challenge:body.codeChallenge,p_return_path:body.returnPath});
        return json({ok:true,authorizeUrl:google.authorizationUrl({state:body.state,codeChallenge:body.codeChallenge,includeAnalytics:body.includeAnalytics===true})});
      }
      if(route.startsWith('ga4-'))return json(await handleGA4({route,body,tenantSlug,user,service,google:()=>client(signal),fetchImpl,signal,publicError}));
      if(route==='assets'){
        const snapshot=await user('snapshot',{p_slug:tenantSlug});
        return json({ok:true,accounts:snapshot.accounts||[],selectedAccountId:snapshot.selectedAccountId||null});
      }
      if(route==='select'){
        if(typeof body.accountId!=='string'||!/^\d{10}$/.test(body.accountId))fail('invalid_request');
        const result=await user('select_account',{p_slug:tenantSlug,p_account_id:body.accountId});
        return json({ok:true,selectedAccountId:result.selectedAccountId});
      }
      if(route==='disconnect')return json({ok:true,...await user('disconnect',{p_slug:tenantSlug})});
      if(route==='sources'){
        if(!Number.isInteger(body.offset??0)||(body.offset??0)<0||(body.offset??0)>100000)fail('invalid_request');
        return json({ok:true,...await user('sources',{p_slug:tenantSlug,p_offset:body.offset??0})});
      }
      if(route==='review'){
        if(!UUID.test(body.commandId||'')||typeof body.campaignId!=='string'||!/^\d{1,20}$/.test(body.campaignId)
          ||!Array.isArray(body.rows)||body.rows.length<1||body.rows.length>200
          ||body.rows.some(row=>!row||typeof row.originKey!=='string'||row.originKey.length>300||typeof row.previewToken!=='string'||row.previewToken.length>200)
          ||new Set(body.rows.map(row=>row.originKey)).size!==body.rows.length
          ||typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.length>500)fail('invalid_request');
        return json({ok:true,...await user('review_sources',{p_slug:tenantSlug,p_command_id:body.commandId,p_campaign_id:body.campaignId,
          p_rows:body.rows.map(({originKey,previewToken})=>({originKey,previewToken})),p_reason:body.reason.trim()})});
      }
      dateRange(body.dateFrom,body.dateTo);
      if(!UUID.test(body.commandId||''))fail('invalid_request');
      const google=client(signal);
      const run=await user('begin_sync',{p_slug:tenantSlug,p_from:body.dateFrom,p_to:body.dateTo,p_command_id:body.commandId});
      if(run.duplicate){
        if(!['success','running'].includes(run.status))fail('sync_failed');
        return json({ok:true,status:run.status,duplicate:true});
      }
      const lease={p_run_id:run.runId,p_lease_token:run.leaseToken};
      try{
        const credentials=await service('sync_credentials',lease);
        const tokens=await google.refreshAccessToken({refreshToken:credentials.refreshToken,signal});
        const report=await google.fetchCampaignReport({accessToken:tokens.accessToken,account:credentials.account,
          dateFrom:body.dateFrom,dateTo:body.dateTo,signal});
        const result=await service('finish_sync',{...lease,p_campaigns:report.campaigns,p_metrics:report.daily,p_success:true,p_error_code:null});
        return json({ok:true,status:result.status,metricRows:result.metricRows});
      }catch(error){
        // Failed/partial reads must never replace stored campaigns or daily metrics.
        await service('finish_sync',{...lease,p_campaigns:[],p_metrics:[],p_success:false,p_error_code:publicError(error)}).catch(()=>{});
        throw error;
      }
    }catch(error){
      let code=error?.name==='AbortError'||error?.name==='TimeoutError'?'service_unavailable':publicError(error);
      if(callback&&code==='request_rejected')code=({token_exchange:'google_oauth_exchange_failed',
        account_discovery:'google_accounts_unavailable',connection_save:'google_connection_save_failed'})[callback.stage]||code;
      if(callback){
        // Log only an internal correlation ID and fixed enums. Never log tokens,
        // OAuth codes, state, user data, RPC messages or provider response bodies.
        try{logFailure({transactionId:callback.transactionId,stage:callback.stage,error:code});}catch{}
      }
      const status=code==='authentication_required'?401:['forbidden','protected_tenant','addon_not_enabled'].includes(code)?403:
        ['service_unavailable','configuration_missing'].includes(code)?503:code==='rate_limited'?429:400;
      return json({ok:false,error:code,...(callback?{returnPath:callback.returnPath}: {})},status);
    }
  };
}
