import PublicSite from '../components/public-site';
import {getPublicSiteSnapshot} from '../lib/public-site';

export const dynamic='force-dynamic';

export async function generateMetadata(){
  const snapshot=await getPublicSiteSnapshot();
  const settings=snapshot?.site?.settings||{};
  return {
    title:settings.siteTitle||'ماركتون | منظومات نمو للمؤسسات',
    description:settings.description||'ماركتون منظومة تشغيل ونمو متخصصة للمؤسسات ومراكز التدريب.',
    alternates:{canonical:'/'},
    openGraph:{
      title:settings.siteTitle||'ماركتون',
      description:settings.description||'',
      type:'website',locale:'ar_SA',siteName:'Marktone'
    }
  };
}

export default async function HomePage(){
  const snapshot=await getPublicSiteSnapshot();
  return <PublicSite snapshot={snapshot}/>;
}
