import PlatformAddonConsole from '../../../components/platform-addon-console';
import {getPlatformAddonCenter} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PaymentProvidersPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformAddonConsole section="providers" initialData={await getPlatformAddonCenter()}/>;
}
