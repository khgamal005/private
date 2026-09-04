import PlatformPromotions from '../../../components/platform-promotions';
import {getPlatformMarketplacePromotions} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PromotionsPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformPromotions
    initialData={await getPlatformMarketplacePromotions()}
  />;
}
