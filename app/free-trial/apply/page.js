import LifetimeFreeApplication from '../../../components/lifetime-free-application';

export const dynamic='force-dynamic';

export const metadata={
  title:'فعّل برنامج ماركتون المجاني مدى الحياة',
  description:'ابحث عن منشأتك واطلب تفعيل الحساب الأساسي المجاني مدى الحياة دون بطاقة بنكية أو مدة انتهاء.',
  alternates:{canonical:'/free-trial/apply'},
  openGraph:{
    title:'برنامج ماركتون المجاني مدى الحياة',
    description:'حساب أساسي مجاني لمنشآت التدريب مع إمكانية إضافة الخدمات والتكاملات عند الحاجة.',
    type:'website',
    locale:'ar_SA',
    siteName:'Marktone'
  }
};

export default function LifetimeFreeApplyPage(){
  return <LifetimeFreeApplication/>;
}
