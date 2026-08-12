import AccountingWorkspace from '../../../../components/accounting-workspace';
import {getTenantAccounting} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function AccountingPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.accounting.read');
  return <AccountingWorkspace slug={slug} initialData={await getTenantAccounting(slug)} initialSection="overview"/>;
}
