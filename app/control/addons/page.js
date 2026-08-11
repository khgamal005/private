import PlatformAddonConsole from '../../../components/platform-addon-console';
import {getPlatformAddonCenter,getPlatformCommerce} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PlatformAddonsPage(){
  await requirePlatformPermission('platform.billing.manage');
  const [center,commerce]=await Promise.all([
    getPlatformAddonCenter(),getPlatformCommerce()
  ]);
  const commerceProducts=new Map((commerce.addons||[]).map(item=>[item.key,item]));
  return <PlatformAddonConsole initialData={{
    ...center,
    addonCategories:commerce.addonCategories||[],
    tenants:center.tenants||commerce.tenants||[],
    products:(center.products||[]).map(item=>({
      ...item,
      categoryId:commerceProducts.get(item.key)?.categoryId||null,
      categoryName:commerceProducts.get(item.key)?.categoryName||null
    }))
  }}/>;
}
