import AddonCenter from '../../../../components/addon-center';
import {getTenantAddonCenter} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TenantAddonsPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.settings.manage');
  return <AddonCenter slug={slug} initialData={await getTenantAddonCenter(slug)}/>;
}
