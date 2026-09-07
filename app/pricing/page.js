import PublicPricing from '../../components/public-pricing';
import {getPublicCommercialCatalog} from '../../lib/commerce/public-catalog';

export const dynamic='force-dynamic';
export const metadata={title:'باقات وإضافات أودير | شريكك في التشغيل والنمو',description:'اختر باقة أودير المناسبة لحجم فريقك. بداية مجانية، وظائف تشغيل مترابطة، وإضافات مستقلة تخدم احتياج منشأتك بأسعار شهرية وسنوية واضحة.',alternates:{canonical:'/pricing'}};
export default async function PricingPage(){
  return <PublicPricing catalog={await getPublicCommercialCatalog()}/>;
}
