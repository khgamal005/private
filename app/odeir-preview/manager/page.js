import {OdeirManagerPreview} from '../../../components/odeir-landing-experience';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';
import './manager-preview.css';

export const dynamic='force-dynamic';

export const metadata={
  title:'معاينة أودير لمدير مركز التدريب | ODEIR',
  description:'نسخة مقارنة مستقلة توضح رحلة العميل والمتدرب وتشغيل مركز التدريب السعودي داخل أودير.',
  robots:{index:false,follow:false,nocache:true}
};

export default async function OdeirManagerPreviewPage(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  return <OdeirManagerPreview cms={managerPreviewCms(snapshot)}/>;
}

function managerPreviewCms(snapshot){
  const home=snapshot?.homePage||{};
  const document=home?.content||home?.document||{};
  const blocks=Array.isArray(document?.blocks)?document.blocks:[];
  const props=id=>blocks.find(block=>block?.id===id)?.props||{};
  const settings=snapshot?.site?.settings||{};
  return {
    hero:props('odeir-home-hero'),
    trust:props('odeir-trust'),
    cta:props('odeir-final-cta'),
    articles:(Array.isArray(snapshot?.articles)?snapshot.articles:[])
      .filter(article=>article?.slug&&article?.title)
      .slice(0,3)
      .map(article=>({
        slug:article.slug,
        title:article.title,
        excerpt:article.excerpt,
        category:article.category,
        coverUrl:article.coverUrl,
        featured:Boolean(article.featured),
        readingMinutes:article.readingMinutes??null,
        publishedAt:article.publishedAt??null
      })),
    settings:{
      customerLoginLabel:settings.customerLoginLabel||'دخول المنشآت',
      customerLoginUrl:settings.customerLoginUrl||'/login'
    }
  };
}
