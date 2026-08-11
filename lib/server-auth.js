import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from './config';

export async function accessToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

export async function authRpc(name,body={},options={}){
  const token=await accessToken();
  if(!token)redirect('/login');
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store'
  });
  if(response.status===401)redirect('/login?reason=session');
  if(response.status===403&&options.redirectForbidden!==false){
    redirect('/login?reason=forbidden');
  }
  if(!response.ok){
    throw new Error(`${name}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export const getContext=()=>authRpc('v2_current_user_context');

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
