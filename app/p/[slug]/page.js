import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../components/built-public-page';
import {PublicContentPage} from '../../../components/public-site';
import {getPublicSiteSnapshot} from '../../../lib/public-site';
import {isBuilderDocument} from '../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {slug}=await params;
  const snapshot=await getPublicSiteSnapshot({pageSlug:slug});
  const page=snapshot?.page;
  if(!page)return {title:'الصفحة غير موجودة | ماركتون'};
  return {
    title:page.seoTitle||`${page.title} | ماركتون`,
    description:page.seoDescription||page.excerpt||'',
    alternates:{canonical:`/p/${slug}`},
    openGraph:{title:page.seoTitle||page.title,description:page.seoDescription||page.excerpt||'',type:'website',locale:'ar_SA'}
  };
}

export default async function PublicPage({params}){
  const {slug}=await params;
  const snapshot=await getPublicSiteSnapshot({pageSlug:slug});
  if(!snapshot?.page)notFound();
  if(isBuilderDocument(snapshot.page.content)){
    return <BuiltPublicPage snapshot={snapshot} content={snapshot.page}/>;
  }
  return <PublicContentPage snapshot={snapshot} content={snapshot.page}/>;
}
