import {
  getTenantAddonNavigation,
  getTenantSettings
} from '../../../../lib/api';
import TenantSettings from '../../../../components/tenant-settings';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function SettingsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  await requireTenantPermission(slug,'tenant.users.manage');
  const addonAccess=await getTenantAddonNavigation(slug);
  return <TenantSettings
    slug={slug}
    initialTab={query?.tab}
    initialData={await getTenantSettings(slug,{addonAccess})}
  />;
}
