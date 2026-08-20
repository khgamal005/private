import {ArticlesIndex} from '../../components/public-site';
import {getCmsPublicSnapshot} from '../../lib/cms-public';

export const dynamic='force-dynamic';
export const metadata={
  title:'مقالات أودير | التشغيل والإدارة والنمو',
  description:'رؤى عملية من أودير حول تشغيل المنشآت وإدارة العملاء والمبيعات والبيانات.',
  alternates:{canonical:'/articles'}
};

export default async function ArticlesPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  return <ArticlesIndex snapshot={snapshot}/>;
}
