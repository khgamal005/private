import MarketplaceStore from '../../../../components/marketplace-store';
import {getTenantMarketplace} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function ServicesStorePage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.users.manage');
  return <MarketplaceStore
    slug={slug}
    initialTab="services"
    initialData={await getTenantMarketplace(slug)}
  />;
}
