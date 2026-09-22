import {notFound} from 'next/navigation';
import PageBuilderWithLibrary from '../../../../../../../components/page-builder-with-library';
import {getAcademyAccess} from '../../../../../../../lib/academy-server';
import {trainingRpc} from '../../../../../../../lib/training-server';

export const dynamic='force-dynamic';
export const revalidate=0;
export const fetchCache='force-no-store';

export default async function AcademyCmsBuilderPage({params}){
  const {slug,entityType,entityId}=await params;
  if(!['page','article'].includes(entityType))notFound();
  await getAcademyAccess(slug,{requiredComponent:'website',permission:'manageWebsite'});
  const [data,workspace]=await Promise.all([
    trainingRpc('v3_cms_builder_snapshot',{p_site_key:'marktone-main',p_tenant_slug:slug,p_entity_type:entityType,p_entity_id:entityId}),
    trainingRpc('v3_cms_workspace_snapshot',{p_site_key:'marktone-main',p_tenant_slug:slug})
  ]);
  return <PageBuilderWithLibrary initialData={{...data,site:workspace.site,context:{...data.context,workspace:'academy'}}}/>;
}
