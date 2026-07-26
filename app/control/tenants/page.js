import {getControl} from '../../../lib/api';
import PlatformTenants from '../../../components/platform-tenants';

export const dynamic='force-dynamic';

export default async function TenantsPage(){
  return <PlatformTenants initialData={await getControl()}/>;
}
