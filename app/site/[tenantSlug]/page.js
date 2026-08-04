import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../components/built-public-page';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';
import {isBuilderDocument} from '../../../lib/website-builder';

export const dynamic='force-dynamic';

export async function generateMetadata({params}){
  const {tenantSlug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug});
  if(!snapshot?.available)return {title:'الموقع غير متاح'};
  const home=snapshot.homePage;
  return {title:home?.seoTitle||snapshot.site?.settings?.siteTitle||snapshot.site?.nameAr,description:home?.seoDescription||snapshot.site?.settings?.description||''};
}

export default async function TenantPublicHome({params}){
  const {tenantSlug}=await params;
  const snapshot=await getCmsPublicSnapshot({tenantSlug});
  const home=snapshot?.homePage;
  if(!snapshot?.available||!home||!isBuilderDocument(home.content))notFound();
  return <BuiltPublicPage snapshot={snapshot} content={home}/>;
}
