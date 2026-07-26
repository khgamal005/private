import CourseCatalog from '../../../../components/course-catalog';
import {getTenant} from '../../../../lib/api';
import {requireTenant} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function CoursesPage({params}){
  const {slug}=await params;
  const [context,data]=await Promise.all([
    requireTenant(slug),
    getTenant(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.academy.write')
  );
  return <CourseCatalog
    slug={slug}
    initialData={data}
    canManage={canManage}
  />;
}
