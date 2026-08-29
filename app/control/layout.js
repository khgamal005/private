import {hasPlatformPermission,requirePlatform} from '../../lib/server-auth';
import {getPlatformRegistrationRequestsSummary} from '../../lib/platform-registration-requests';
import {optionalServerRead} from '../../lib/server-resilience';
import {getPlatformSupport} from '../../lib/support-api';
import WorkspaceShell from '../../components/workspace-shell';

export const dynamic='force-dynamic';
const SUPPORT_PERMISSIONS=[
  'platform.support.read','platform.support.reply','platform.support.manage'
];

export default async function ControlLayout({children}){
  const context=await requirePlatform();
  const canManageTenants=hasPlatformPermission(context,'platform.tenants.manage');
  const canReadSupport=SUPPORT_PERMISSIONS.some(permission=>
    hasPlatformPermission(context,permission)
  );
  const [platformRegistrationSummary,platformSupport]=await Promise.all([
    canManageTenants
      ?optionalServerRead(
        'platform-shell-registration-summary',
        ()=>getPlatformRegistrationRequestsSummary(),
        null
      )
      :null,
    canReadSupport
      ?optionalServerRead(
        'platform-shell-support-summary',
        ()=>getPlatformSupport({limit:1}),
        null
      )
      :null
  ]);
  return <WorkspaceShell
    kind="platform"
    title="ODEIR Platform Control"
    email={context.subject.email}
    userName={context.subject.fullName}
    permissions={context.platformPermissions||[]}
    roleKey={context.platformRoles?.[0]||'platform_user'}
    roleLabel={context.platformRoleLabel||'موظف المنصة'}
    platformRegistrationSummary={platformRegistrationSummary}
    supportSummary={platformSupport?.summary||null}
  >
    {children}
  </WorkspaceShell>;
}
