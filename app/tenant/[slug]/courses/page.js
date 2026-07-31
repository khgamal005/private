import CourseCatalog from '../../../../components/course-catalog';
import CommerceIntegrationHub from '../../../../components/commerce-integration-hub';
import {getTenant} from '../../../../lib/api';
import {getTenantCommerceHub} from '../../../../lib/commerce-api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function CoursesPage({params}){
  const {slug}=await params;
  const [context,data,commerceHub]=await Promise.all([
    requireTenantPermission(slug,'tenant.academy.read'),
    getTenant(slug),
    getTenantCommerceHub(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.academy.write')
  );
  const canManageCommerce=Boolean(
    commerceHub?.canManage||commerceHub?.woocommerce?.canManage
  );
  return <>
    <CommerceIntegrationHub
      slug={slug}
      initialData={commerceHub}
      canManage={canManageCommerce}
    />
    <CourseCatalog
      slug={slug}
      initialData={data}
      commerceData={commerceHub?.woocommerce||{}}
      canManage={canManage}
      canManageCommerce={canManageCommerce}
    />
  </>;
}
