import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../components/built-public-page';
import {PublicContentPage} from '../../../components/public-site';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';
import {isBuilderDocument} from '../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',articleSlug:slug});
  const article=snapshot?.article;
  if(!article)return {title:'المقال غير موجود | أودير'};
  return {
    title:article.seoTitle||`${article.title} | أودير`,
    description:article.seoDescription||article.excerpt||'',
    alternates:{canonical:article.canonicalUrl||`/articles/${slug}`},
    openGraph:{title:article.seoTitle||article.title,description:article.seoDescription||article.excerpt||'',type:'article',locale:'ar_SA',publishedTime:article.publishedAt||undefined}
  };
}

export default async function ArticlePage({params}){
  const {slug}=await params;
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',articleSlug:slug});
  if(!snapshot?.article)notFound();
  if(isBuilderDocument(snapshot.article.content)){
    return <BuiltPublicPage snapshot={snapshot} content={snapshot.article} type="article"/>;
  }
  return <PublicContentPage snapshot={snapshot} content={snapshot.article} type="article"/>;
}
