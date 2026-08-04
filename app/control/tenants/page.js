import {getPlatformControl} from '../../../lib/platform-api';
import {requirePlatformPermission} from '../../../lib/server-auth';
import PlatformTenants from '../../../components/platform-tenants';

export const dynamic='force-dynamic';

export default async function TenantsPage(){
  await requirePlatformPermission('platform.tenants.manage');
  return <PlatformTenants initialData={await getPlatformControl()}/>;
}
