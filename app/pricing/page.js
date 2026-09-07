import PublicPricing from '../../components/public-pricing';
import {getPublicCommercialCatalog} from '../../lib/commerce/public-catalog';

export const dynamic='force-dynamic';
export const metadata={title:'نسخ أودير وأسعار الإضافات | ODEIR',description:'أربع نسخ لأودير وإضافات مستقلة بسعر شهري أو سنوي ثابت، بلا مستويات داخل الإضافة أو حزم مشتركة.',alternates:{canonical:'/pricing'}};
export default async function PricingPage(){
  return <PublicPricing catalog={await getPublicCommercialCatalog()}/>;
}
