import {notFound} from 'next/navigation';
import {PublicContentPage} from '../../../components/public-site';
import {getPublicSiteSnapshot} from '../../../lib/public-site';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {slug}=await params;
  const snapshot=await getPublicSiteSnapshot({articleSlug:slug});
  const article=snapshot?.article;
  if(!article)return {title:'المقال غير موجود | ماركتون'};
  return {
    title:article.seoTitle||`${article.title} | ماركتون`,
    description:article.seoDescription||article.excerpt||'',
    alternates:{canonical:`/articles/${slug}`},
    openGraph:{title:article.seoTitle||article.title,description:article.seoDescription||article.excerpt||'',type:'article',locale:'ar_SA',publishedTime:article.publishedAt||undefined}
  };
}

export default async function ArticlePage({params}){
  const {slug}=await params;
  const snapshot=await getPublicSiteSnapshot({articleSlug:slug});
  if(!snapshot?.article)notFound();
  return <PublicContentPage snapshot={snapshot} content={snapshot.article} type="article"/>;
}
