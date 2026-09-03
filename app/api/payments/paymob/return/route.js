import {cookies} from 'next/headers';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../../lib/config';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$/;
const PROVIDER_ORDER_ID=/^[1-9][0-9]{0,29}$/;
const RESOLVER_KEYS=new Set(['schemaVersion','slug','attemptId']);
const MAX_QUERY_CHARS=8192;
const MAX_UPSTREAM_BYTES=16*1024;

const PRIVATE_HEADERS={
  'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};

export async function GET(request){
  try{
    const url=new URL(request.url);
    if(url.search.length>MAX_QUERY_CHARS)return privateResponse(400);
    const slugs=url.searchParams.getAll('slug');
    const attempts=url.searchParams.getAll('attempt');

    // Intention requests carry an ODEIR-generated tenant/attempt binding.
    if(slugs.length===1&&attempts.length===1
       &&SLUG.test(slugs[0])&&UUID.test(attempts[0])){
      return cleanRedirect(slugs[0],attempts[0]);
    }

    // QuickLink uses the static Integration Response Callback configured in
    // Paymob. Its order_id is only a lookup hint: caller JWT + tenant RBAC are
    // enforced by the read-only RPC, and payment state is never trusted here.
    if(slugs.length!==0||attempts.length!==0)return privateResponse(400);
    const providerOrderIds=url.searchParams.getAll('order_id');
    if(providerOrderIds.length!==1
       ||!PROVIDER_ORDER_ID.test(providerOrderIds[0])){
      return privateResponse(400);
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return privateResponse(401);

    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v1_tenant_paymob_resolve_return`,
      {
        method:'POST',
        redirect:'error',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify({p_provider_order_id:providerOrderIds[0]}),
        cache:'no-store',
        signal:AbortSignal.timeout(8000)
      }
    );
    const upstream=await readTextLimited(response,MAX_UPSTREAM_BYTES);
    if(!response.ok||upstream.tooLarge)return privateResponse(
      response.status===401?401:response.status>=500?503:404
    );
    let resolved;
    try{resolved=JSON.parse(upstream.text)}catch{return privateResponse(502);}
    if(!resolved||typeof resolved!=='object'||Array.isArray(resolved)
       ||Object.keys(resolved).some(key=>!RESOLVER_KEYS.has(key))
       ||resolved.schemaVersion!==1||!SLUG.test(String(resolved.slug||''))
       ||!UUID.test(String(resolved.attemptId||''))){
      return privateResponse(502);
    }
    return cleanRedirect(resolved.slug,resolved.attemptId);
  }catch{
    return privateResponse(503);
  }
}

function cleanRedirect(slug,attemptId){
  // All provider-owned query fields are discarded before rendering. The
  // destination page polls the signed-in user's server-authorized status.
  const location='/tenant/'+encodeURIComponent(slug)
    +'/payments/paymob/return?attempt='+encodeURIComponent(attemptId);
  return new Response(null,{
    status:303,
    headers:{...PRIVATE_HEADERS,Location:location}
  });
}

function privateResponse(status){
  return new Response(null,{status,headers:PRIVATE_HEADERS});
}

async function readTextLimited(response,maxBytes){
  const contentLength=response.headers.get('content-length');
  if(contentLength&&/^\d+$/.test(contentLength)
     &&Number(contentLength)>maxBytes){
    await response.body?.cancel('response_body_too_large').catch(()=>{});
    return {tooLarge:true,text:''};
  }
  if(!response.body)return {tooLarge:false,text:''};
  const reader=response.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0;
  let text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done){
        text+=decoder.decode();
        return {tooLarge:false,text};
      }
      bytes+=value.byteLength;
      if(bytes>maxBytes){
        await reader.cancel('response_body_too_large').catch(()=>{});
        return {tooLarge:true,text:''};
      }
      text+=decoder.decode(value,{stream:true});
    }
  }finally{
    reader.releaseLock();
  }
}
