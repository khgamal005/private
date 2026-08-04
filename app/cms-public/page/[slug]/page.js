import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../../components/built-public-page';
import {PublicContentPage} from '../../../../components/public-site';
import {getCmsPublicSnapshot} from '../../../../lib/cms-public';
import {isBuilderDocument} from '../../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',pageSlug:slug});
  const page=snapshot?.page;
  if(!page)return {title:'الصفحة غير موجودة | ماركتون'};
  return {title:page.seoTitle||`${page.title} | ماركتون`,description:page.seoDescription||page.excerpt||'',alternates:{canonical:page.canonicalUrl||`/p/${slug}`},robots:page.robots||'index,follow'};
}

export default async function CmsPublicPage({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',pageSlug:slug});
  if(!snapshot?.page)notFound();
  return isBuilderDocument(snapshot.page.content)
    ?<BuiltPublicPage snapshot={snapshot} content={snapshot.page}/>
    :<PublicContentPage snapshot={snapshot} content={snapshot.page}/>;
}
