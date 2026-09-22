import {notFound} from 'next/navigation';
import PageBuilderWithLibrary from '../../../../../../../components/page-builder-with-library';
import {authRpc,requireTenantPermission} from '../../../../../../../lib/server-auth';
import {redirectLegacyAcademy} from '../../../../../../../lib/academy-legacy';

export const dynamic='force-dynamic';
export const revalidate=0;
export const fetchCache='force-no-store';

export default async function TenantCmsBuilderPage({params}){
  const {slug,entityType,entityId}=await params;
  if(!['page','article'].includes(entityType))notFound();
  await redirectLegacyAcademy(slug,{section:'website',entityType,entityId});
  await requireTenantPermission(slug,'tenant.website.manage');
  const [data,workspace]=await Promise.all([
    authRpc('v3_cms_builder_snapshot',{
      p_site_key:'marktone-main',p_tenant_slug:slug,
      p_entity_type:entityType,p_entity_id:entityId
    }),
    authRpc('v3_cms_workspace_snapshot',{p_site_key:'marktone-main',p_tenant_slug:slug})
  ]);
  return <PageBuilderWithLibrary initialData={{...data,site:workspace.site}}/>;
}
