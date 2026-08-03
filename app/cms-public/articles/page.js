import {CmsArticlesIndex} from '../../../components/built-public-page';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';

export const dynamic='force-dynamic';
export const metadata={title:'المقالات | ماركتون',description:'مقالات ورؤى عملية من ماركتون حول النمو والتشغيل والتسويق والمبيعات والبيانات.'};

export default async function CmsArticlesPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  return <CmsArticlesIndex snapshot={snapshot}/>;
}
