import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../components/built-public-page';
import {getPublicSiteSnapshot} from '../../../lib/public-site';
import {authRpc,requirePlatform} from '../../../lib/server-auth';

export const dynamic='force-dynamic';
export const metadata={title:'معاينة الصفحة | Marktone Visual Builder',robots:{index:false,follow:false}};

export default async function WebsiteBuilderPreview({params}){
  const {pageId}=await params;
  await requirePlatform();
  const [builder,publicSite]=await Promise.all([
    authRpc('v2_platform_page_builder_snapshot',{p_page_id:pageId}),
    getPublicSiteSnapshot()
  ]);
  if(!builder?.page)notFound();
  return <BuiltPublicPage
    snapshot={publicSite}
    content={{...builder.page,content:builder.document?.draftDocument}}
    preview
  />;
}
