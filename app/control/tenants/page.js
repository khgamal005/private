import {getPlatformControl} from '../../../lib/platform-api';
import {requirePlatformPermission,hasPlatformPermission} from '../../../lib/server-auth';
import PlatformTenants from '../../../components/platform-tenants';

export const dynamic='force-dynamic';

export default async function TenantsPage(){
  const context=await requirePlatformPermission('platform.tenants.manage');
  const data=await getPlatformControl();
  return <PlatformTenants initialData={{...data,adminPermissions:{
    canDelete:hasPlatformPermission(context,'platform.tenants.delete')
  }}}/>;
}
