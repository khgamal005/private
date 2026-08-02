import CourseCatalog from '../../../../components/course-catalog';
import {getTenant} from '../../../../lib/api';
import {getTenantCommerceHub} from '../../../../lib/commerce-api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

async function safeCommerceHub(slug){
  try{
    return await getTenantCommerceHub(slug);
  }catch{
    return null;
  }
}

export default async function CoursesPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(
    slug,
    'tenant.academy.read'
  );
  const [data,commerceHub]=await Promise.all([
    getTenant(slug),
    safeCommerceHub(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.academy.write')
  );
  const canManageCommerce=Boolean(
    commerceHub?.canManage||commerceHub?.woocommerce?.canManage
  );
  return <CourseCatalog
    slug={slug}
    initialData={data}
    commerceData={commerceHub?.woocommerce||{}}
    canManage={canManage}
    canManageCommerce={canManageCommerce}
  />;
}
