import TeamDirectory from '../../../../components/team-directory';
import {getTenant} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TeamPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.people.read');
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManageUsers=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
  );
  const data=await getTenant(slug,{includeAccess:canManageUsers});
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.people.manage')
  );
  const canInvite=canManageUsers;
  const canResetPasswords=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.reset_password')
  );
  return <TeamDirectory
    slug={slug}
    initialData={data}
    canManage={canManage}
    canInvite={canInvite}
    canResetPasswords={canResetPasswords}
    platformAccess={context.platformAccess}
    viewerMembershipId={membership?.membershipId||null}
    viewerRoleKeys={membership?.roles||[]}
  />;
}
