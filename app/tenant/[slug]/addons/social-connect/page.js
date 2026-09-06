import {redirect} from 'next/navigation';
import SocialConnectV2 from '../../../../../components/social-connect-v2';
import {authRpc,requireTenantPermission} from '../../../../../lib/server-auth';

export const dynamic='force-dynamic';
export const metadata={title:'ربط حساب الإعلانات | ODEIR'};

export default async function SocialConnectPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const context=await requireTenantPermission(slug,'tenant.meta_connect.read');
  const snapshot=await authRpc(
    'v1_tenant_meta_connect_v2_snapshot',
    {p_tenant_slug:slug},
    {timeoutMs:8000,retryTransient:true}
  );
  if(!snapshot?.addonEnabled){
    redirect(`/tenant/${encodeURIComponent(slug)}?reason=addon_required`);
  }
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.meta_connect.manage')
  );
  return <SocialConnectV2
    slug={slug}
    initialData={snapshot}
    canManage={canManage}
    outcome={typeof query?.social_connect==='string'?query.social_connect:''}
    reason={typeof query?.reason==='string'?query.reason:''}
  />;
}
