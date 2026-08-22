import TaskCalendarPage from '../../../../components/task-calendar-page';
import {getTenantTaskCalendar} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';
import {resolveTenantRoleKey} from '../../../../lib/tenant-role-policy';

export const dynamic='force-dynamic';
const SALES_TASK_ROLES=new Set([
  'sales_manager',
  'sales_supervisor',
  'sales_user'
]);

export default async function TasksPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.work.read');
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const roleKey=resolveTenantRoleKey({context,slug});
  const includeSales=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.crm.read')
  );
  const salesTaskScope=SALES_TASK_ROLES.has(roleKey);
  return <TaskCalendarPage
    slug={slug}
    initialData={await getTenantTaskCalendar(slug,{
      includeSales,
      taskScope:salesTaskScope?'sales':'all'
    })}
    initialFocus={SALES_TASK_ROLES.has(roleKey)?'today':'calendar'}
    showTodayDistribution={SALES_TASK_ROLES.has(roleKey)}
    embedded
  />;
}
