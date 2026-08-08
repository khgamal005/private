import PlatformMarketplace from '../../../components/platform-marketplace';
import {getPlatformMarketplace} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function MarketplacePage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformMarketplace initialData={await getPlatformMarketplace()}/>;
}
