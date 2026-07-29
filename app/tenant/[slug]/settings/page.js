import {getTenantSettings} from '../../../../lib/api';
import TenantSettings from '../../../../components/tenant-settings';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function SettingsPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.users.manage');
  return <TenantSettings
    slug={slug}
    initialData={await getTenantSettings(slug)}
  />;
}
