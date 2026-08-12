import {notFound} from 'next/navigation';
import AccountingWorkspace from '../../../../../components/accounting-workspace';
import {getTenantAccounting} from '../../../../../lib/api';
import {requireTenantAddon,requireTenantPermission} from '../../../../../lib/server-auth';

export const dynamic='force-dynamic';

const SECTIONS=new Set([
  'receivables','quotes','invoices','payments','adjustments',
  'incentives','reports','settings','zatca'
]);

export default async function AccountingSectionPage({params}){
  const {slug,section}=await params;
  if(!SECTIONS.has(section))notFound();
  if(section==='zatca'){
    await requireTenantAddon(slug,'zatca',{permission:'tenant.accounting.read'});
  }else{
    await requireTenantPermission(slug,'tenant.accounting.read');
  }
  return <AccountingWorkspace slug={slug} initialData={await getTenantAccounting(slug)} initialSection={section}/>;
}
