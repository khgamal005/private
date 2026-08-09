import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../components/built-public-page';
import LifetimeFreeApplication from '../../components/lifetime-free-application';
import {PublicContentPage} from '../../components/public-site';
import {getCmsPublicSnapshot} from '../../lib/cms-public';
import {isBuilderDocument} from '../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',pageSlug:'free-trial'});
  const page=snapshot?.page||{};
  const title=page.seoTitle||'برنامج ماركتون المجاني مدى الحياة';
  const description=page.seoDescription||'نظام تشغيل أساسي مجاني لمنشآت التدريب دون بطاقة بنكية أو مدة انتهاء.';
  return {
    title,
    description,
    alternates:{canonical:'/free-trial'},
    openGraph:{title,description,type:'website',locale:'ar_SA',siteName:'Marktone'}
  };
}

export default async function FreeTrialPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main',pageSlug:'free-trial'});
  if(snapshot?.page&&isBuilderDocument(snapshot.page.content)){
    return <BuiltPublicPage snapshot={snapshot} content={snapshot.page}/>;
  }
  if(snapshot?.page)return <PublicContentPage snapshot={snapshot} content={snapshot.page}/>;
  if(process.env.CMS_V3_LEGACY_FALLBACK==='true')return <LifetimeFreeApplication/>;
  notFound();
}
