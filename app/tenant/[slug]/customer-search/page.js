import CustomerSearch from '../../../../components/customer-search';
import {getTenantCustomerSearch} from '../../../../lib/api';
import {requireTenant} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function CustomerSearchPage({params}){
  const {slug}=await params;
  await requireTenant(slug);
  return <CustomerSearch
    slug={slug}
    initialData={await getTenantCustomerSearch(slug)}
  />;
}
