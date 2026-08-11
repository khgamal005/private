import CommerceIntegrationHub from '../../../../components/commerce-integration-hub';
import {getTenantCommerceHub} from '../../../../lib/commerce-api';
import {requireTenantAddon} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

const FALLBACK_PROVIDERS=[
  {
    providerKey:'woocommerce',
    nameAr:'WooCommerce',
    nameEn:'WooCommerce',
    descriptionAr:'اربط متجر WordPress وانقل الدورات والأسعار والعروض والطلبات والعملاء إلى ماركتون.',
    setupMode:'manual',
    adapterStatus:'active',
    featureEnabled:true,
    sortOrder:10,
    capabilities:['products','categories','attributes','variations','coupons','orders','customers'],
    requiredConfigKeys:['storeUrl'],
    requiredSecretKeys:['consumerKey','consumerSecret'],
    optionalSecretKeys:[]
  },
  {
    providerKey:'salla',
    nameAr:'سلة',
    nameEn:'Salla',
    descriptionAr:'مزامنة الدورات والطلبات والعملاء من متجر سلة السعودي داخل منظومة التشغيل.',
    setupMode:'hybrid',
    adapterStatus:'active',
    featureEnabled:true,
    sortOrder:20,
    capabilities:['products','categories','coupons','orders','customers'],
    requiredConfigKeys:[],
    requiredSecretKeys:['accessToken'],
    optionalSecretKeys:['refreshToken']
  },
  {
    providerKey:'zid',
    nameAr:'زد',
    nameEn:'Zid',
    descriptionAr:'اربط متجر زد واجمع المنتجات والطلبات وحالات الدفع والعملاء في ماركتون.',
    setupMode:'hybrid',
    adapterStatus:'active',
    featureEnabled:true,
    sortOrder:30,
    capabilities:['products','categories','coupons','orders','customers'],
    requiredConfigKeys:['storeId'],
    requiredSecretKeys:['accessToken','authorizationToken'],
    optionalSecretKeys:['refreshToken']
  },
  {
    providerKey:'shopify',
    nameAr:'Shopify',
    nameEn:'Shopify',
    descriptionAr:'مزامنة كتالوج Shopify والخصومات والطلبات والعملاء عبر Admin API.',
    setupMode:'hybrid',
    adapterStatus:'active',
    featureEnabled:true,
    sortOrder:40,
    capabilities:['products','collections','variants','discounts','orders','customers'],
    requiredConfigKeys:['shopDomain'],
    requiredSecretKeys:['accessToken'],
    optionalSecretKeys:['webhookSecret']
  },
  {
    providerKey:'custom',
    nameAr:'متجر مخصص',
    nameEn:'Custom API',
    descriptionAr:'ربط أي متجر أو موقع مخصص يوفّر API موثقًا وآمنًا.',
    setupMode:'manual',
    adapterStatus:'active',
    featureEnabled:true,
    sortOrder:90,
    capabilities:['products','categories','coupons','orders','customers'],
    requiredConfigKeys:['baseUrl'],
    requiredSecretKeys:[],
    optionalSecretKeys:[
      'apiKey','bearerToken','basicUsername','basicPassword','webhookSecret'
    ]
  }
];

const PRODUCT_BY_PROVIDER={custom:'custom_store'};

function normalizeProviders(data,enabledProductKeys){
  const enabled=new Set(enabledProductKeys||[]);
  const hasRemoteProviders=Array.isArray(data?.providers)&&data.providers.length>0;
  const providers=hasRemoteProviders?data.providers:FALLBACK_PROVIDERS;
  const wooCommerce=data?.woocommerce||{};
  return providers.filter(provider=>enabled.has(
    PRODUCT_BY_PROVIDER[provider.providerKey]||provider.providerKey
  )).map(provider=>{
    if(provider.providerKey!=='woocommerce')return provider;
    return {
      ...provider,
      connection:provider.connection||wooCommerce.connection||null,
      featureEnabled:provider.featureEnabled
        ??wooCommerce.featureEnabled
        ??true,
      counts:provider.counts||wooCommerce.counts||{},
      recentRuns:provider.recentRuns||wooCommerce.recentRuns||[]
    };
  });
}

async function safeCommerceHub(slug,enabledProductKeys){
  try{
    const data=await getTenantCommerceHub(slug);
    return {
      ...data,
      providers:normalizeProviders(data,enabledProductKeys),
      degraded:!Array.isArray(data?.providers)||data.providers.length===0
    };
  }catch{
    return {
      providers:normalizeProviders(null,enabledProductKeys),
      canManage:false,
      degraded:true
    };
  }
}

export default async function IntegrationsPage({params}){
  const {slug}=await params;
  const context=await requireTenantAddon(
    slug,
    ['woocommerce','salla','zid','shopify','custom_store'],
    {permission:'tenant.users.manage'}
  );
  const commerceHub=await safeCommerceHub(
    slug,
    context.addonAccess?.enabledProductKeys
  );
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.users.manage')
    ||membership?.permissions?.includes('tenant.integrations.manage')
    ||commerceHub?.canManage
  );
  return <CommerceIntegrationHub
    slug={slug}
    initialData={commerceHub}
    canManage={canManage}
  />;
}
