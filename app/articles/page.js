import {ArticlesIndex} from '../../components/public-site';
import {getPublicSiteSnapshot} from '../../lib/public-site';

export const dynamic='force-dynamic';
export const metadata={
  title:'مقالات ماركتون | التشغيل والنمو والمبيعات',
  description:'رؤى عملية من ماركتون حول تشغيل المؤسسات ومراكز التدريب والتسويق والمبيعات والبيانات.',
  alternates:{canonical:'/articles'}
};

export default async function ArticlesPage(){
  const snapshot=await getPublicSiteSnapshot();
  return <ArticlesIndex snapshot={snapshot}/>;
}
