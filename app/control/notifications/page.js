import PlatformNotificationHub from '../../../components/platform-notification-hub';
import {authRpc,requireAnyPlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

const NOTIFICATION_PERMISSIONS=[
  'platform.billing.manage',
  'platform.tenants.manage',
  'platform.settings.manage',
  'platform.control.write'
];

export default async function PlatformNotificationsPage(){
  await requireAnyPlatformPermission(NOTIFICATION_PERMISSIONS);
  const initialData=await authRpc(
    'v1_platform_lifecycle_notification_center',
    {p_action:'list',p_notification_id:null},
    {retryTransient:true,timeoutMs:8000}
  );
  return <PlatformNotificationHub initialData={initialData}/>;
}
