import {redirect} from 'next/navigation';
import TeamDirectory from '../../../../components/team-directory';
import {getTenant} from '../../../../lib/api';
import {
  getTenantSalesTeams,
  getTenantStaffExtensions
} from '../../../../lib/achievement';
import {requireTenantPermission} from '../../../../lib/server-auth';
import {tenantRolePolicyFromContext} from '../../../../lib/tenant-role-policy';

export const dynamic='force-dynamic';

export default async function TeamPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.people.read');
  if(!tenantRolePolicyFromContext(context,slug).showTeam){
    redirect(`/tenant/${encodeURIComponent(slug)}`);
  }
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManageUsers=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
  );
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.people.manage')
  );
  const [data,salesTeams,staffExtensions]=await Promise.all([
    getTenant(slug,{includeAccess:canManageUsers}),
    getTenantSalesTeams(slug).catch(()=>({supervisors:[],members:[]})),
    getTenantStaffExtensions(slug).catch(()=>({configured:false,extensions:[]}))
  ]);
  const canInvite=canManageUsers;
  const canResetPasswords=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.reset_password')
  );
  return <TeamDirectory
    slug={slug}
    initialData={data}
    salesTeams={salesTeams}
    staffExtensions={staffExtensions}
    canManage={canManage}
    canInvite={canInvite}
    canResetPasswords={canResetPasswords}
    platformAccess={context.platformAccess}
    viewerMembershipId={membership?.membershipId||null}
    viewerRoleKeys={membership?.roles||[]}
  />;
}
