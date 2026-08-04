import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../../../components/built-public-page';
import {getCmsPublicSnapshot} from '../../../../../lib/cms-public';
import {isBuilderDocument} from '../../../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {tenantSlug,slug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug,pageSlug:slug});
  const page=snapshot?.page;
  if(!page)return {title:'الصفحة غير موجودة'};
  return {title:page.seoTitle||`${page.title} | ${snapshot.site?.nameAr||''}`,description:page.seoDescription||page.excerpt||'',alternates:{canonical:page.canonicalUrl||`/site/${tenantSlug}/p/${slug}`},robots:page.robots||'index,follow'};
}

export default async function TenantPublicPage({params}){
  const {tenantSlug,slug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug,pageSlug:slug});
  if(!snapshot?.page||!isBuilderDocument(snapshot.page.content))notFound();
  return <BuiltPublicPage snapshot={snapshot} content={snapshot.page}/>;
}
