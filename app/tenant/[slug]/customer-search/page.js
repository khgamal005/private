import CustomerSearch from '../../../../components/customer-search';
import {getTenantCustomerSearch} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function CustomerSearchPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.crm.read');
  return <CustomerSearch
    slug={slug}
    initialData={await getTenantCustomerSearch(slug)}
  />;
}
