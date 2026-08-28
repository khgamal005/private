import LifetimeFreeApplication from '../../../components/lifetime-free-application';

export const dynamic='force-dynamic';

export const metadata={
  title:'سجّل منشأتك مجانًا | أودير',
  description:'ابحث عن منشأتك واطلب تفعيل الخطة المجانية الحالية دون بطاقة بنكية، مع حدود واضحة وإمكانية التوسع حسب احتياج المنشأة.',
  alternates:{canonical:'/free-trial/apply'},
  openGraph:{
    title:'ابدأ مع أودير مجانًا',
    description:'ابدأ بالخطة المجانية الحالية، ثم أضف السعات والخدمات والتكاملات عندما تحتاج إليها.',
    type:'website',
    locale:'ar_SA',
    siteName:'ODEIR'
  }
};

export default async function LifetimeFreeApplyPage({searchParams}){
  const query=await searchParams;
  return <LifetimeFreeApplication embedded={query?.embedded==='1'}/>;
}
