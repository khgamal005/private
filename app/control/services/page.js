import PlatformServices from '../../../components/platform-services';
import {getPlatformCommerce} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function ServicesPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformServices initialData={await getPlatformCommerce()}/>;
}
