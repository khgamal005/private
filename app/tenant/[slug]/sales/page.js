import {getTenantOperations} from '../../../../lib/api';
import SalesWorkspace from '../../../../components/sales-workspace';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function SalesPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.crm.read');
  return <SalesWorkspace
    slug={slug}
    initialData={await getTenantOperations(slug)}
  />;
}
