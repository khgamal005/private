import BuiltPublicPage from '../components/built-public-page';
import PublicSite from '../components/public-site';
import {getCmsPublicSnapshot} from '../lib/cms-public';
import {isBuilderDocument} from '../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  const settings=snapshot?.site?.settings||{};
  const home=snapshot?.homePage||{};
  const title=home.seoTitle||settings.siteTitle||'أودير | منصة تشغيل وإدارة المنشآت';
  const description=home.seoDescription||settings.description||'أودير يوحّد العملاء والمبيعات والتسجيل والمهام والفوترة والتقارير في منصة واحدة.';
  return {
    title,
    description,
    alternates:{canonical:'/'},
    openGraph:{title,description,type:'website',locale:'ar_SA',siteName:'ODEIR'}
  };
}

export default async function HomePage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  if(!snapshot?.available&&process.env.CMS_V3_LEGACY_FALLBACK!=='true'){
    throw new Error('CMS v3 public snapshot is unavailable for marktone-main');
  }
  const home=snapshot?.homePage;
  if(home&&isBuilderDocument(home.content)){
    return <BuiltPublicPage snapshot={snapshot} content={home}/>;
  }
  return <PublicSite snapshot={snapshot}/>;
}
