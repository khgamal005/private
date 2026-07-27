import EngagementWorkspace from '../../../../components/engagement-workspace';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function IncentivesPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.incentives.read');
  return <EngagementWorkspace slug={slug}/>;
}
