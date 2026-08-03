import {notFound} from 'next/navigation';
import PageBuilder from '../../../../../../../components/page-builder';
import {authRpc,requireTenantPermission} from '../../../../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function TenantCmsBuilderPage({params}){
  const {slug,entityType,entityId}=await params;
  if(!['page','article'].includes(entityType))notFound();
  await requireTenantPermission(slug,'tenant.website.manage');
  const [data,workspace]=await Promise.all([
    authRpc('v3_cms_builder_snapshot',{
      p_site_key:'marktone-main',p_tenant_slug:slug,
      p_entity_type:entityType,p_entity_id:entityId
    }),
    authRpc('v3_cms_workspace_snapshot',{p_site_key:'marktone-main',p_tenant_slug:slug})
  ]);
  return <PageBuilder initialData={{...data,site:workspace.site}}/>;
}
