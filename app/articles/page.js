import {ArticlesIndex} from '../../components/public-site';
import {getCmsPublicSnapshot} from '../../lib/cms-public';

export const dynamic='force-dynamic';
export const metadata={
  title:'مقالات ماركتون | التشغيل والنمو والمبيعات',
  description:'رؤى عملية من ماركتون حول تشغيل المؤسسات ومراكز التدريب والتسويق والمبيعات والبيانات.',
  alternates:{canonical:'/articles'}
};

export default async function ArticlesPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  return <ArticlesIndex snapshot={snapshot}/>;
}
