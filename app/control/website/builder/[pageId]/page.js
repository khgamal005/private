import PageBuilder from '../../../../../components/page-builder';
import {authRpc,requirePlatform} from '../../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function VisualBuilderPage({params}){
  const {pageId}=await params;
  await requirePlatform();
  const data=await authRpc('v2_platform_page_builder_snapshot',{p_page_id:pageId});
  return <PageBuilder initialData={data}/>;
}
