import {requirePlatform} from '../../lib/server-auth';
import WorkspaceShell from '../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function ControlLayout({children}){
  const context=await requirePlatform();
  return <WorkspaceShell
    kind="platform"
    title="Marktone Platform Control"
    email={context.subject.email}
    userName={context.subject.fullName}
    permissions={context.platformPermissions||[]}
    roleKey={context.platformRoles?.[0]||'platform_user'}
    roleLabel={context.platformRoleLabel||'موظف المنصة'}
  >
    {children}
  </WorkspaceShell>;
}
