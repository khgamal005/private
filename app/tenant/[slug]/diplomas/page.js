import DiplomaWorkspace from '../../../../components/diploma-workspace';
import {authRpc, requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic = 'force-dynamic';

export default async function DiplomaPage({params}) {
  const {slug} = await params;
  await requireTenantPermission(slug, 'tenant.accounting.read');
  const data = await authRpc('v1_tenant_diploma_snapshot', {p_slug: slug, p_contract_id: null});
  return <DiplomaWorkspace slug={slug} initialData={data}/>;
}
