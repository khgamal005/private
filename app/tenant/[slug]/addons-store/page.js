import MarketplaceStore from '../../../../components/marketplace-store';
import {getTenantMarketplace} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function AddonsStorePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.users.manage');
  return <MarketplaceStore
    slug={slug}
    initialTab="addons"
    initialData={await getTenantMarketplace(slug)}
  />;
}
