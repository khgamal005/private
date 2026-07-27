import TaskCalendarPage from '../../../../components/task-calendar-page';
import {getTenantOperations} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TasksPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.work.read');
  return <TaskCalendarPage
    slug={slug}
    initialData={await getTenantOperations(slug)}
    embedded
  />;
}
