import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from './config';
export async function accessToken(){return (await cookies()).get(ACCESS_COOKIE)?.value||null}
export async function authRpc(name,body={}){const token=await accessToken();if(!token)redirect('/login');const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});if(r.status===401||r.status===403)redirect('/login?reason=session');if(!r.ok)throw new Error(`${name}: ${r.status} ${await r.text()}`);return r.json()}
export const getContext=()=>authRpc('v2_current_user_context');
export async function requirePlatform(){const c=await getContext();if(!c.platformAccess)redirect(c.memberships?.[0]?.tenantSlug?`/tenant/${c.memberships[0].tenantSlug}`:'/login?reason=forbidden');return c}
export async function requireTenant(slug){const c=await getContext();if(!c.platformAccess&&!c.memberships?.some(m=>m.tenantSlug===slug))redirect('/login?reason=forbidden');return c}
export async function requireTenantPermission(slug,permission){
  const context=await requireTenant(slug);
  if(context.platformAccess)return context;
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  if(membership?.permissions?.includes(permission))return context;
  if(permission==='tenant.workspace.read')redirect('/login?reason=forbidden');
  redirect(`/tenant/${encodeURIComponent(slug)}?reason=forbidden`);
}
