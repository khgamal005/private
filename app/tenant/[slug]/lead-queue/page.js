import {getTenantLeadIntake} from '../../../../lib/api';
import {presentLeadAssignments} from '../../../../lib/lead-distribution-mode.mjs';
import {requireTenantPermission} from '../../../../lib/server-auth';
import LeadIntakeWorkspace from '../../../../components/lead-intake-workspace';

export const dynamic='force-dynamic';

export default async function LeadQueuePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.leads.read');
  const initialData=await getTenantLeadIntake(slug);
  return <LeadIntakeWorkspace
    slug={slug}
    initialData={{
      ...initialData,
      assignments:presentLeadAssignments(initialData.assignments)
    }}
  />;
}
