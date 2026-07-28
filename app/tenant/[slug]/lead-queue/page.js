import {getTenantLeadIntake} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';
import LeadIntakeWorkspace from '../../../../components/lead-intake-workspace';

export const dynamic='force-dynamic';

export default async function LeadQueuePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.leads.read');
  return <LeadIntakeWorkspace
    slug={slug}
    initialData={await getTenantLeadIntake(slug)}
  />;
}
