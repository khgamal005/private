import MarketingCommandCenter from '../../../../components/marketing-command-center';
import {getTenantMarketingHub} from '../../../../lib/marketing-api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

const FALLBACK_PROVIDERS=[
  {
    providerKey:'meta',nameAr:'Meta Ads',nameEn:'Meta Ads',sortOrder:10,
    descriptionAr:'Facebook وInstagram عبر Marketing API الرسمي.',
    apiVersion:'v26.0',supportedApiVersions:['v26.0'],
    requiredConfigKeys:['accountId'],optionalConfigKeys:['businessId'],
    requiredSecretKeys:['accessToken'],optionalSecretKeys:['appId','appSecret'],
    documentationUrl:'https://developers.facebook.com/docs/marketing-api/'
  },
  {
    providerKey:'google_ads',nameAr:'Google Ads',nameEn:'Google Ads',sortOrder:20,
    descriptionAr:'البحث وYouTube وPerformance Max عبر Google Ads API الرسمي.',
    apiVersion:'v25',supportedApiVersions:['v25','v24'],
    requiredConfigKeys:['customerId'],optionalConfigKeys:['loginCustomerId'],
    requiredSecretKeys:['developerToken'],
    optionalSecretKeys:['accessToken','refreshToken','clientId','clientSecret'],
    documentationUrl:'https://developers.google.com/google-ads/api/'
  },
  {
    providerKey:'tiktok_ads',nameAr:'TikTok Ads',nameEn:'TikTok Ads',sortOrder:30,
    descriptionAr:'حملات TikTok وتقارير الأداء عبر API for Business الرسمي.',
    apiVersion:'v1.3',supportedApiVersions:['v1.3'],
    requiredConfigKeys:['advertiserId'],optionalConfigKeys:[],
    requiredSecretKeys:['accessToken'],optionalSecretKeys:['appId','secret'],
    documentationUrl:'https://business-api.tiktok.com/portal/docs'
  },
  {
    providerKey:'snapchat_ads',nameAr:'Snapchat Ads',nameEn:'Snapchat Ads',sortOrder:40,
    descriptionAr:'حملات Snapchat والإنفاق والتحويلات عبر Marketing API الرسمي.',
    apiVersion:'v1',supportedApiVersions:['v1'],
    requiredConfigKeys:['adAccountId'],optionalConfigKeys:['organizationId'],
    requiredSecretKeys:['accessToken'],
    optionalSecretKeys:['refreshToken','clientId','clientSecret'],
    documentationUrl:'https://developers.snap.com/marketing-api/Ads-API/introduction'
  }
];

function validDate(value){
  const result=String(value||'');
  return /^\d{4}-\d{2}-\d{2}$/.test(result)?result:null;
}

async function safeSnapshot(slug,range){
  try{
    const data=await getTenantMarketingHub(slug,range);
    return {
      ...data,
      providers:Array.isArray(data?.providers)&&data.providers.length
        ?data.providers
        :FALLBACK_PROVIDERS,
      degraded:false
    };
  }catch{
    return {
      featureEnabled:true,
      canManage:false,
      degraded:true,
      providers:FALLBACK_PROVIDERS,
      range:{from:range.from,to:range.to},
      settings:{
        model:'last_non_direct',clickWindowDays:30,viewWindowDays:1,
        baseCurrency:'SAR',timezone:'Asia/Riyadh'
      },
      summary:{currency:'SAR'},
      campaigns:[],sources:[],daily:[],funnel:[],insights:[],
      commerceSources:[],dataHealth:{}
    };
  }
}

export default async function MarketingPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const range={from:validDate(query?.from),to:validDate(query?.to)};
  const [context,snapshot]=await Promise.all([
    requireTenantPermission(slug,'tenant.marketing.read'),
    safeSnapshot(slug,range)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const canManage=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.marketing.manage')
    ||snapshot.canManage
  );
  return <MarketingCommandCenter
    slug={slug}
    initialData={snapshot}
    canManage={canManage}
  />;
}
