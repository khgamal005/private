export function connectionNeedsReauthorization(data,now=Date.now()){
  if(data.status==='reauth_required')return true;
  if(data.status!=='connected')return false;
  return [data.tokenExpiresAt,data.dataAccessExpiresAt].some(value=>{
    if(!value)return false;
    const expiresAt=Date.parse(value);
    return Number.isFinite(expiresAt)&&expiresAt<=now;
  });
}

export async function runConnectionAction({
  name,slug,fetcher,navigate,onStart,onDisconnected,onError,onSettled
}){
  let navigating=false;
  onStart();
  try{
    const response=await fetcher(`/api/tenant/social-connect/${name}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({tenantSlug:slug}),
      signal:AbortSignal.timeout(15_000)
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'request_rejected');
    if(name==='start'){
      const authorizeUrl=new URL(result.authorizeUrl);
      if(authorizeUrl.protocol!=='https:'||authorizeUrl.hostname!=='www.facebook.com'){
        throw new Error('invalid_authorization_url');
      }
      navigate(authorizeUrl.toString());
      navigating=true;
      return;
    }
    onDisconnected();
  }catch(error){
    onError(error instanceof Error?error.message:'request_rejected');
  }finally{
    if(!navigating)onSettled();
  }
}

export async function loadDeletionStatus({code,supabaseUrl,fetcher=fetch}){
  if(!/^[a-f0-9]{48}$/.test(code))return {status:'invalid_code'};
  try{
    const endpoint=new URL('/functions/v1/meta-oauth-v2/data-deletion/status',supabaseUrl);
    endpoint.searchParams.set('code',code);
    const response=await fetcher(endpoint,{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(response.status===404)return {status:'not_found'};
    if(!response.ok)return {status:'unavailable'};
    const result=await response.json();
    if(result.ok!==true||!['completed','no_data','failed'].includes(result.status)){
      return {status:'unavailable'};
    }
    return {status:result.status};
  }catch{
    return {status:'unavailable'};
  }
}
