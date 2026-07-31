import CommerceIntegrationHub from '../../../../components/commerce-integration-hub';
import {getTenantCommerceHub} from '../../../../lib/commerce-api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

async function safeCommerceHub(slug){
  try{
    return await getTenantCommerceHub(slug);
  }catch{
    return {providers:[],canManage:false};
  }
}

export default async function IntegrationsPage({params}){
  const {slug}=await params;
  const [context,commerceHub]=await Promise.all([
    requireTenantPermission(slug,'tenant.users.manage'),
    safeCommerceHub(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
    ||commerceHub?.canManage
  );
  return <CommerceIntegrationHub
    slug={slug}
    initialData={commerceHub}
    canManage={canManage}
  />;
}
