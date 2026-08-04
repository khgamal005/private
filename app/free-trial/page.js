import FreeTrialLanding from '../../components/free-trial-landing';

export const dynamic='force-dynamic';

export const metadata={
  title:'ماركتون فلو | جرّب نظام تشغيل منشآت التدريب مجانًا',
  description:'ابحث عن منشأتك واطلب تجربة ماركتون فلو المجانية لمدة 14 يومًا؛ منصة موحدة للتسويق والمبيعات والتسجيل والدورات والتقارير.',
  alternates:{canonical:'/free-trial'},
  openGraph:{
    title:'ماركتون فلو | من أول إعلان إلى متدرب مسجّل',
    description:'كل رحلة منشأة التدريب في مسار تشغيل واحد.',
    type:'website',
    locale:'ar_SA',
    siteName:'Marktone'
  }
};

export default function FreeTrialPage(){
  return <FreeTrialLanding/>;
}
