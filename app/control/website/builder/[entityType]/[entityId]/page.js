import {notFound} from 'next/navigation';
import PageBuilderWithLibrary from '../../../../../../components/page-builder-with-library';
import {authRpc,requirePlatform} from '../../../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function CmsBuilderPage({params}){
  const {entityType,entityId}=await params;
  if(!['page','article'].includes(entityType))notFound();
  await requirePlatform();
  const [data,workspace]=await Promise.all([
    authRpc('v3_cms_builder_snapshot',{
      p_site_key:'marktone-main',p_tenant_slug:null,
      p_entity_type:entityType,p_entity_id:entityId
    }),
    authRpc('v3_cms_workspace_snapshot',{p_site_key:'marktone-main',p_tenant_slug:null})
  ]);
  return <PageBuilderWithLibrary initialData={{...data,site:workspace.site}}/>;
}
