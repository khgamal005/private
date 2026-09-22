import CmsStudio from '../../../../components/cms-studio';
import {authRpc,requireTenantAddon} from '../../../../lib/server-auth';
import {redirectLegacyAcademy} from '../../../../lib/academy-legacy';

export const dynamic='force-dynamic';

export default async function TenantWebsitePage({params}){
  const {slug}=await params;
  await redirectLegacyAcademy(slug,{section:'website'});
  await requireTenantAddon(slug,'cms_pro',{
    permission:'tenant.website.read'
  });
  const data=await authRpc('v3_cms_workspace_snapshot',{
    p_site_key:'marktone-main',
    p_tenant_slug:slug
  });
  return <CmsStudio initialData={data}/>;
}
