import TaskCalendarPage from '../../../../components/task-calendar-page';
import {getTenantOperations} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TasksPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.work.read');
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const includeSales=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.crm.read')
  );
  return <TaskCalendarPage
    slug={slug}
    initialData={await getTenantOperations(slug,{includeSales})}
    embedded
  />;
}
