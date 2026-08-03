import WebsiteAdmin from '../../../components/website-admin';
import {authRpc,requirePlatform} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function WebsiteManagementPage(){
  await requirePlatform();
  const data=await authRpc('v2_platform_site_snapshot');
  return <WebsiteAdmin initialData={data}/>;
}
