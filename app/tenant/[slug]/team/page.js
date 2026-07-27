import TeamDirectory from '../../../../components/team-directory';
import {getTenant} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TeamPage({params}){
  const {slug}=await params;
  const [context,data]=await Promise.all([
    requireTenantPermission(slug,'tenant.people.read'),
    getTenant(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.people.manage')
  );
  const canInvite=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
  );
  return <TeamDirectory
    slug={slug}
    initialData={data}
    canManage={canManage}
    canInvite={canInvite}
  />;
}
