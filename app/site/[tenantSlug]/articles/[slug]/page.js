import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../../../components/built-public-page';
import {getCmsPublicSnapshot} from '../../../../../lib/cms-public';
import {isBuilderDocument} from '../../../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {tenantSlug,slug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug,articleSlug:slug});
  const article=snapshot?.article;
  if(!article)return {title:'المقال غير موجود'};
  return {title:article.seoTitle||`${article.title} | ${snapshot.site?.nameAr||''}`,description:article.seoDescription||article.excerpt||'',alternates:{canonical:article.canonicalUrl||`/site/${tenantSlug}/articles/${slug}`},robots:article.robots||'index,follow'};
}

export default async function TenantArticlePage({params}){
  const {tenantSlug,slug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug,articleSlug:slug});
  if(!snapshot?.article||!isBuilderDocument(snapshot.article.content))notFound();
  return <BuiltPublicPage snapshot={snapshot} content={snapshot.article}/>;
}
