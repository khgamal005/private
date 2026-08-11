import MarketplaceAddonStoreV2 from '../../../../components/marketplace-addon-store-v2';
import {getTenantMarketplaceV2} from '../../../../lib/marketplace-v2';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function AddonsStorePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.users.manage');
  return <MarketplaceAddonStoreV2
    slug={slug}
    initialData={await getTenantMarketplaceV2(slug)}
  />;
}

