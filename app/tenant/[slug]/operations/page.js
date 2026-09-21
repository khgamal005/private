import OperatingFoundationPanel from '../../../../components/operating-foundation-panel';
import {authRpc,requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function OperatingFoundationPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.settings.manage');
  const initialData=await authRpc('v1_tenant_operating_snapshot',{p_tenant_slug:slug});
  return <OperatingFoundationPanel slug={slug} initialData={initialData}/>;
}
