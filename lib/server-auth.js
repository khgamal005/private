import {cache} from 'react';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from './config';

const TRANSIENT_RPC_STATUSES=new Set([408,425,429,502,503,504,520]);

function rpcRequestId(response){
  return response.headers.get('sb-request-id')
    ||response.headers.get('x-request-id')
    ||response.headers.get('cf-ray')
    ||null;
}

function rpcSignal(timeoutMs){
  const value=Number(timeoutMs);
  return Number.isFinite(value)&&value>0
    ?AbortSignal.timeout(value)
    :undefined;
}

function wait(milliseconds){
  return new Promise(resolve=>setTimeout(resolve,milliseconds+Math.random()*60));
}

export async function accessToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

export async function authRpc(name,body={},options={}){
  const token=await accessToken();
  if(!token)redirect('/login');
  const attempts=options.retryTransient===true?2:1;
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    const startedAt=Date.now();
    let response;
    try{
      response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify(body),
        cache:'no-store',
        signal:rpcSignal(options.timeoutMs)
      });
    }catch(error){
      lastError=error;
      if(attempt<attempts){
        await wait(80);
        continue;
      }
      console.error('[auth-rpc-network-failure]',{
        name,
        durationMs:Date.now()-startedAt,
        errorName:error instanceof Error?error.name:'UnknownError'
      });
      throw error;
    }
    if(response.status===401)redirect('/login?reason=session');
    if(response.status===403&&options.redirectForbidden!==false){
      redirect('/login?reason=forbidden');
    }
    if(response.ok){
      try{
        return await response.json();
      }catch(error){
        lastError=error;
        if(attempt<attempts){
          await wait(80);
          continue;
        }
        console.error('[auth-rpc-invalid-json]',{
          name,
          requestId:rpcRequestId(response),
          durationMs:Date.now()-startedAt,
          errorName:error instanceof Error?error.name:'UnknownError'
        });
        throw error;
      }
    }
    const detail=await response.text();
    const requestId=rpcRequestId(response);
    lastError=new Error(
      `${name}: ${response.status} ${detail}`
      +`${requestId?` [requestId=${requestId}]`:''}`
    );
    if(attempt<attempts&&TRANSIENT_RPC_STATUSES.has(response.status)){
      await wait(80);
      continue;
    }
    console.error('[auth-rpc-failure]',{
      name,
      status:response.status,
      requestId,
      durationMs:Date.now()-startedAt
    });
    throw lastError;
  }
  throw lastError||new Error(`${name}: request_failed`);
}

export const getContext=cache(()=>authRpc(
  'v2_current_user_context',
  {},
  {retryTransient:true,timeoutMs:8000}
));

export function hasPlatformPermission(context,permission){
  return Boolean(
    Array.isArray(context?.platformPermissions)
    &&context.platformPermissions.includes(permission)
  );
}

export function canAccessPlatformControl(context){
  return Boolean(
    context?.platformControlAccess
    ||context?.platformAccess
    ||hasPlatformPermission(context,'platform.control.read')
  );
}

export async function requirePlatform(){
  const context=await getContext();
  if(context.subject?.mustChangePassword)redirect('/change-password');
  if(!canAccessPlatformControl(context)){
    redirect(
      context.memberships?.[0]?.tenantSlug
        ?`/tenant/${context.memberships[0].tenantSlug}`
        :'/login?reason=forbidden'
    );
  }
  return context;
}

export async function requirePlatformPermission(permission){
  const context=await requirePlatform();
  if(hasPlatformPermission(context,permission))return context;
  redirect('/control?reason=forbidden');
}

export async function requireAnyPlatformPermission(permissions){
  const context=await requirePlatform();
  if((permissions||[]).some(permission=>hasPlatformPermission(context,permission))){
    return context;
  }
  redirect('/control?reason=forbidden');
}

export async function requireTenant(slug){
  const context=await getContext();
  if(context.subject?.mustChangePassword)redirect('/change-password');
  if(!context.platformAccess&&!context.memberships?.some(item=>item.tenantSlug===slug)){
    redirect('/login?reason=forbidden');
  }
  return context;
}

export async function requireTenantPermission(slug,permission){
  const context=await requireTenant(slug);
  if(context.platformAccess)return context;
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  if(membership?.permissions?.includes(permission))return context;
  if(permission==='tenant.workspace.read')redirect('/login?reason=forbidden');
  redirect(`/tenant/${encodeURIComponent(slug)}?reason=forbidden`);
}

export async function requireTenantAddon(slug,productKeys,{permission}={}){
  const context=permission
    ?await requireTenantPermission(slug,permission)
    :await requireTenant(slug);
  const required=(Array.isArray(productKeys)?productKeys:[productKeys])
    .filter(Boolean);
  if(!required.length)throw new Error('tenant_addon_key_required');
  const addonAccess=await authRpc(
    'v3_tenant_addon_navigation_snapshot',
    {p_slug:slug},
    {redirectForbidden:false}
  );
  const enabled=new Set(addonAccess?.enabledProductKeys||[]);
  if(required.some(productKey=>enabled.has(productKey))){
    return {...context,addonAccess};
  }
  redirect(`/tenant/${encodeURIComponent(slug)}?reason=addon_required`);
}
