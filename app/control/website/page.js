import CmsStudio from '../../../components/cms-studio';
import {authRpc,requirePlatform} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function WebsiteManagementPage(){
  await requirePlatform();
  const data=await authRpc('v3_cms_workspace_snapshot',{
    p_site_key:'marktone-main',
    p_tenant_slug:null
  });
  return <CmsStudio initialData={data}/>;
}
