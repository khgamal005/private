import CommerceIntegrationHub from '../../../../components/commerce-integration-hub';
import {getTenantCommerceHub} from '../../../../lib/commerce-api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

const FALLBACK_PROVIDERS=[
  {providerKey:'woocommerce',nameAr:'WooCommerce',nameEn:'WooCommerce',descriptionAr:'اربط متجر WordPress وانقل الدورات والأسعار والعروض والطلبات والعملاء إلى ماركتون.',setupMode:'manual',adapterStatus:'active',featureEnabled:true,capabilities:['products','categories','attributes','variations','coupons','orders','customers'],requiredConfigKeys:['storeUrl'],requiredSecretKeys:['consumerKey','consumerSecret'],optionalSecretKeys:[]},
  {providerKey:'salla',nameAr:'سلة',nameEn:'Salla',descriptionAr:'مزامنة الدورات والطلبات والعملاء من متجر سلة السعودي داخل منظومة التشغيل.',setupMode:'hybrid',adapterStatus:'active',featureEnabled:true,capabilities:['products','categories','coupons','orders','customers'],requiredConfigKeys:[],requiredSecretKeys:['accessToken'],optionalSecretKeys:['refreshToken']},
  {providerKey:'zid',nameAr:'زد',nameEn:'Zid',descriptionAr:'اربط متجر زد واجمع المنتجات والطلبات وحالات الدفع والعملاء في ماركتون.',setupMode:'hybrid',adapterStatus:'active',featureEnabled:true,capabilities:['products','categories','coupons','orders','customers'],requiredConfigKeys:['storeId'],requiredSecretKeys:['accessToken','authorizationToken'],optionalSecretKeys:['refreshToken']},
  {providerKey:'shopify',nameAr:'Shopify',nameEn:'Shopify',descriptionAr:'مزامنة كتالوج Shopify والخصومات والطلبات والعملاء عبر Admin API.',setupMode:'hybrid',adapterStatus:'active',featureEnabled:true,capabilities:['products','collections','variants','discounts','orders','customers'],requiredConfigKeys:['shopDomain'],requiredSecretKeys:['accessToken'],optionalSecretKeys:['webhookSecret']},
  {providerKey:'custom',nameAr:'متجر مخصص',nameEn:'Custom API',descriptionAr:'ربط أي متجر أو موقع مخصص يوفّر API موثقًا وآمنًا.',setupMode:'manual',adapterStatus:'active',featureEnabled:true,capabilities:['products','categories','coupons','orders','customers'],requiredConfigKeys:['baseUrl'],requiredSecretKeys:[],optionalSecretKeys:['apiKey','bearerToken','basicUsername','basicPassword','webhookSecret']}
];

async function safeCommerceHub(slug){
  try{
    const data=await getTenantCommerceHub(slug);
    return {
      ...data,
      providers:Array.isArray(data?.providers)&&data.providers.length
        ?data.providers
        :FALLBACK_PROVIDERS
    };
  }catch{
    return {providers:FALLBACK_PROVIDERS,canManage:false,degraded:true};
  }
}

export default async function IntegrationsPage({params}){
  const {slug}=await params;
  const [context,commerceHub]=await Promise.all([
    requireTenantPermission(slug,'tenant.users.manage'),
    safeCommerceHub(slug)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
    ||commerceHub?.canManage
  );
  return <CommerceIntegrationHub
    slug={slug}
    initialData={commerceHub}
    canManage={canManage}
  />;
}
