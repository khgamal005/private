import LifetimeFreeApplication from '../../../components/lifetime-free-application';

export const dynamic='force-dynamic';

export const metadata={
  title:'سجّل منشأتك مجانًا | أودير',
  description:'ابحث عن منشأتك واطلب تفعيل الحساب الأساسي المجاني مدى الحياة دون بطاقة بنكية أو مدة انتهاء.',
  alternates:{canonical:'/free-trial/apply'},
  openGraph:{
    title:'ابدأ مع أودير مجانًا',
    description:'حساب أساسي مجاني لمنشآت التدريب مع إمكانية إضافة الخدمات والتكاملات عند الحاجة.',
    type:'website',
    locale:'ar_SA',
    siteName:'ODEIR'
  }
};

export default async function LifetimeFreeApplyPage({searchParams}){
  const query=await searchParams;
  return <LifetimeFreeApplication embedded={query?.embedded==='1'}/>;
}
