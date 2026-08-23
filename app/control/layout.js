import {hasPlatformPermission,requirePlatform} from '../../lib/server-auth';
import {getPlatformRegistrationRequestsSummary} from '../../lib/platform-registration-requests';
import WorkspaceShell from '../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function ControlLayout({children}){
  const context=await requirePlatform();
  let platformRegistrationSummary=null;
  if(hasPlatformPermission(context,'platform.tenants.manage')){
    try{
      platformRegistrationSummary=await getPlatformRegistrationRequestsSummary();
    }catch{
      // The rest of Platform Control remains available during a migration or
      // transient notification failure. The inbox page reports its own error.
    }
  }
  return <WorkspaceShell
    kind="platform"
    title="ODEIR Platform Control"
    email={context.subject.email}
    userName={context.subject.fullName}
    permissions={context.platformPermissions||[]}
    roleKey={context.platformRoles?.[0]||'platform_user'}
    roleLabel={context.platformRoleLabel||'موظف المنصة'}
    platformRegistrationSummary={platformRegistrationSummary}
  >
    {children}
  </WorkspaceShell>;
}
