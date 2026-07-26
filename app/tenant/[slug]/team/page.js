import TeamDirectory from '../../../../components/team-directory';
import {getTenant} from '../../../../lib/api';
import {requireTenant} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TeamPage({params}){
  const {slug}=await params;
  const [context,data]=await Promise.all([
    requireTenant(slug),
    getTenant(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.people.manage')
  );
  return <TeamDirectory
    slug={slug}
    initialData={data}
    canManage={canManage}
  />;
}
