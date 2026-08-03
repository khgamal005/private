import {notFound} from 'next/navigation';
import {CmsArticlesIndex} from '../../../../components/built-public-page';
import {getCmsPublicSnapshot} from '../../../../lib/cms-public';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {tenantSlug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug});
  if(!snapshot?.available)return {title:'المقالات'};
  return {title:`المقالات | ${snapshot.site?.nameAr||''}`,description:snapshot.site?.settings?.articlesDescription||snapshot.site?.settings?.description||''};
}

export default async function TenantArticlesPage({params}){
  const {tenantSlug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug});
  if(!snapshot?.available)notFound();
  return <CmsArticlesIndex snapshot={snapshot}/>;
}
