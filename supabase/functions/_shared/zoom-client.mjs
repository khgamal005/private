// Provider-only adapter. No tenant selection, credentials cache or implicit S2S fallback.
export class ZoomError extends Error {
  constructor(code,{status=0,retryAfter=0,uncertain=false}={}){super(code);this.code=code;this.status=status;this.retryAfter=retryAfter;this.uncertain=uncertain;}
}
const bad=code=>{throw new ZoomError(code);};
export function zoomId(value){if(typeof value!=='string'||!value||value.length>512)bad('zoom_invalid_identifier');return encodeURIComponent(value);}
export function instanceId(value){const encoded=zoomId(value);return value.startsWith('/')||value.includes('//')?encodeURIComponent(encoded):encoded;}
export function zoomUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(url.hostname==='zoom.us'||url.hostname.endsWith('.zoom.us'))&&!value.includes('\\');}catch{return false;}}
export function retryDelay(error,attempt,random=Math.random){
  return Math.min(86400,Math.max(error.retryAfter||0,Math.min(3600,2**Math.min(attempt,11))* (0.8+random()*0.4)));
}
export function createZoomClient({clientId,clientSecret,redirectUri},{fetchImpl=fetch,timeoutMs=12000,maxPages=10}={}){
  async function request(path,{token,method='GET',body,form=false}={}){
    const url=form?'https://zoom.us/oauth/token':`https://api.zoom.us/v2${path}`;
    let response;
    try{response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{
      authorization:form?`Basic ${btoa(`${clientId}:${clientSecret}`)}`:`Bearer ${token}`,
      'content-type':form?'application/x-www-form-urlencoded':'application/json'
    },...(body!==undefined?{body:form?new URLSearchParams(body).toString():JSON.stringify(body)}:{})});}
    catch{throw new ZoomError('zoom_network_error',{uncertain:method!=='GET'});}
    const value=await response.json().catch(()=>null);
    if(!response.ok){
      const retry=response.headers.get('retry-after');
      const retryAfter=retry?Math.max(0,Number.isFinite(Number(retry))?Number(retry):(Date.parse(retry)-Date.now())/1000):0;
      const code=response.status===401?'zoom_reauth_required':response.status===403?'zoom_scope_or_license_required':response.status===429?'zoom_rate_limited':response.status>=500?'zoom_provider_unavailable':'zoom_provider_rejected';
      throw new ZoomError(code,{status:response.status,retryAfter,uncertain:method!=='GET'&&response.status>=500});
    }
    if(response.status!==204&&(!value||typeof value!=='object'))throw new ZoomError('zoom_invalid_provider_response',{uncertain:method!=='GET'});
    return value||{};
  }
  async function pages(path,key,token){
    const items=[];let next='';const visited=new Set();
    for(let i=0;i<maxPages;i++){
      const separator=path.includes('?')?'&':'?';
      const page=await request(`${path}${separator}page_size=100${next?`&next_page_token=${encodeURIComponent(next)}`:''}`,{token});
      if(!Array.isArray(page[key]))bad('zoom_invalid_provider_response');
      items.push(...page[key]);next=page.next_page_token||'';
      if(!next)return {items,complete:true};
      if(visited.has(next))bad('zoom_pagination_cycle');visited.add(next);
    }
    return {items,complete:false};
  }
  function authorizationUrl(state){
    if(!clientId||!clientSecret||!redirectUri||!/^[a-f0-9]{64}$/.test(state))bad('zoom_configuration_missing');
    const redirect=new URL(redirectUri);if(redirect.protocol!=='https:'||redirect.pathname!=='/api/zoom/callback'||redirect.search||redirect.hash||redirect.username)bad('zoom_configuration_missing');
    const u=new URL('https://zoom.us/oauth/authorize');u.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,state}).toString();return u.href;
  }
  const resource=kind=>kind==='webinar'?'webinars':kind==='meeting'?'meetings':bad('zoom_invalid_kind');
  return {
    authorizationUrl,
    exchangeCode:code=>request('',{method:'POST',form:true,body:{grant_type:'authorization_code',code,redirect_uri:redirectUri}}),
    refresh:refreshToken=>request('',{method:'POST',form:true,body:{grant_type:'refresh_token',refresh_token:refreshToken}}),
    identity:token=>request('/users/me',{token}),
    users:token=>pages('/users?status=active','users',token),
    user:(id,token)=>request(`/users/${zoomId(id)}`,{token}),
    settings:(id,token)=>request(`/users/${zoomId(id)}/settings`,{token}),
    meetings:(id,token)=>pages(`/users/${zoomId(id)}/meetings?type=scheduled`,'meetings',token),
    create:(host,kind,body,token)=>request(`/users/${zoomId(host)}/${resource(kind)}`,{token,method:'POST',body}),
    get:(id,kind,token)=>request(`/${resource(kind)}/${zoomId(id)}`,{token}),
    update:(id,kind,body,token)=>request(`/${resource(kind)}/${zoomId(id)}`,{token,method:'PATCH',body}),
    cancel:(id,kind,occurrence,token)=>request(`/${resource(kind)}/${zoomId(id)}${occurrence?`?occurrence_id=${zoomId(occurrence)}`:''}`,{token,method:'DELETE'}),
    register:(id,kind,body,token)=>request(`/${resource(kind)}/${zoomId(id)}/registrants`,{token,method:'POST',body}),
    registrants:(id,kind,token)=>pages(`/${resource(kind)}/${zoomId(id)}/registrants`,'registrants',token),
    revokeRegistrant:(id,kind,registrantId,token)=>request(`/${resource(kind)}/${zoomId(id)}/registrants/status`,{token,method:'PUT',body:{action:'cancel',registrants:[{id:registrantId}]}}),
    instances:(id,token,kind='meeting')=>request(`/past_${resource(kind)}/${zoomId(id)}/instances`,{token}),
    past:(uuid,token)=>request(`/past_meetings/${instanceId(uuid)}`,{token}),
    participants:(uuid,kind,token)=>pages(kind==='webinar'?`/past_webinars/${instanceId(uuid)}/participants`:`/past_meetings/${instanceId(uuid)}/participants`,'participants',token),
    recordings:(uuid,token)=>request(`/meetings/${instanceId(uuid)}/recordings`,{token}),
    polls:(id,kind,token)=>request(`/${resource(kind)}/${zoomId(id)}/polls`,{token}),
    createPoll:(id,kind,body,token)=>request(`/${resource(kind)}/${zoomId(id)}/polls`,{token,method:'POST',body}),
    userToken:(id,type,token)=>{if(!['zak','token'].includes(type))bad('zoom_invalid_token_kind');return request(`/users/${zoomId(id)}/token?type=${type}`,{token});}
  };
}

export async function connectionAccessToken(rpc,client,connectionId){
  const leaseId=crypto.randomUUID();
  const lease=await rpc('v1_zoom_token_lease',{p_connection_id:connectionId,p_lease_id:leaseId,p_action:'claim'});
  if(lease.status==='ready')return lease;
  if(lease.status==='busy')throw new ZoomError('zoom_refresh_busy',{retryAfter:5});
  if(lease.status!=='refresh')throw new ZoomError('zoom_reauth_required');
  let tokens;
  try{tokens=await client.refresh(lease.refreshToken);}catch(error){
    await rpc('v1_zoom_token_lease',{p_connection_id:connectionId,p_lease_id:leaseId,p_action:'failed',p_generation:lease.generation}).catch(()=>{});
    throw error;
  }
  // A lost DB response is retried neither with old refresh tokens nor by creating
  // a second grant. A surviving/expired lease exposes an explicit reconnect state.
  return rpc('v1_zoom_token_lease',{p_connection_id:connectionId,p_lease_id:leaseId,p_action:'complete',p_generation:lease.generation,p_tokens:tokens});
}

export function verifiedHost(user,settings,accountId){
  if(user.account_id&&user.account_id!==accountId)bad('zoom_account_mismatch');
  const feature=settings?.feature||{};const capacity=Number(feature.meeting_capacity);
  return {id:String(user.id),account_id:accountId,display_name:user.display_name||`${user.first_name||''} ${user.last_name||''}`.trim(),status:user.status,type:user.type,
    capacity:Number.isInteger(capacity)&&capacity>0?capacity:null,
    capabilities:{meeting:Number.isInteger(capacity)&&capacity>0,cloud_recording:settings?.recording?.cloud_recording===true,
      webinar:feature.webinar===true,webinar_capacity:Number(feature.webinar_capacity)||null,registration:true,externalBusyCoverage:'unknown'}};
}
