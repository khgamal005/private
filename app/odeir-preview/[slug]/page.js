import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../components/built-public-page';
import {getOdeirLegalContent,odeirLegalSlugs,odeirPreviewSnapshot} from '../../../lib/odeir-preview-content';

export const dynamicParams=false;

export function generateStaticParams(){
  return odeirLegalSlugs.map(slug=>({slug}));
}

export async function generateMetadata({params}){
  const {slug}=await params;
  const page=getOdeirLegalContent(slug);
  if(!page)return {};
  return {
    title:page.seoTitle,
    description:page.seoDescription,
    robots:{index:false,follow:false}
  };
}

export default async function OdeirPreviewLegalPage({params}){
  const {slug}=await params;
  const content=getOdeirLegalContent(slug);
  if(!content)notFound();
  return <BuiltPublicPage snapshot={odeirPreviewSnapshot} content={content}/>;
}
