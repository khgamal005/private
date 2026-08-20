import BuiltPublicPage from '../components/built-public-page';
import OdeirLandingExperience from '../components/odeir-landing-experience';
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
    openGraph:{title,description,type:'website',locale:'ar_SA',siteName:'ODEIR',images:[{url:'/odeir/odeir-og.jpg',width:1200,height:630,alt:'أودير — تشغيل أوضح للمنشآت'}]},
    twitter:{card:'summary_large_image',title,description,images:['/odeir/odeir-og.jpg']}
  };
}

export default async function HomePage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  if(!snapshot?.available&&process.env.CMS_V3_LEGACY_FALLBACK!=='true'){
    throw new Error('CMS v3 public snapshot is unavailable for marktone-main');
  }
  const home=snapshot?.homePage;
  if(home&&isBuilderDocument(home.content)){
    return <OdeirLandingExperience cms={landingCms(snapshot,home)}/>;
  }
  if(home)return <BuiltPublicPage snapshot={snapshot} content={home}/>;
  return <PublicSite snapshot={snapshot}/>;
}

function landingCms(snapshot,home){
  const document=home?.content||home?.document||{};
  const blocks=Array.isArray(document?.blocks)?document.blocks:[];
  const props=id=>blocks.find(block=>block?.id===id)?.props||{};
  const settings=snapshot?.site?.settings||{};
  return {
    hero:props('odeir-home-hero'),
    capabilities:props('odeir-capabilities'),
    trust:props('odeir-trust'),
    faq:props('odeir-faq'),
    cta:props('odeir-final-cta'),
    settings:{
      customerLoginLabel:settings.customerLoginLabel||'دخول المنشآت',
      customerLoginUrl:settings.customerLoginUrl||'/login'
    }
  };
}
