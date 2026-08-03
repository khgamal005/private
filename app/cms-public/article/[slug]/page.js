import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../../components/built-public-page';
import {PublicContentPage} from '../../../../components/public-site';
import {getCmsPublicSnapshot} from '../../../../lib/cms-public';
import {isBuilderDocument} from '../../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',articleSlug:slug});
  const article=snapshot?.article;
  if(!article)return {title:'المقال غير موجود | ماركتون'};
  return {title:article.seoTitle||`${article.title} | ماركتون`,description:article.seoDescription||article.excerpt||'',alternates:{canonical:article.canonicalUrl||`/articles/${slug}`},robots:article.robots||'index,follow'};
}

export default async function CmsArticlePage({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',articleSlug:slug});
  if(!snapshot?.article)notFound();
  return isBuilderDocument(snapshot.article.content)
    ?<BuiltPublicPage snapshot={snapshot} content={snapshot.article}/>
    :<PublicContentPage snapshot={snapshot} content={snapshot.article} type="article"/>;
}
