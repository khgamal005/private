import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const PROVIDERS=new Set(['tamara','paymob','paypal']);
const PUBLIC_CONFIG_KEYS=new Set([
  'merchantId','merchantAccountId','integrationId','webhookId'
]);

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await request.json();
    const providerKey=String(body.providerKey||'');
    const environment=String(body.environment||'');
    const checkoutMode=String(body.checkoutMode||'');
    const supportedCurrencies=Array.isArray(body.supportedCurrencies)
      ?body.supportedCurrencies.map(value=>String(value).toUpperCase())
      :[];
    const secrets=body.secrets&&typeof body.secrets==='object'
      &&!Array.isArray(body.secrets)?body.secrets:{};
    const publicConfig=body.publicConfig&&typeof body.publicConfig==='object'
      &&!Array.isArray(body.publicConfig)?body.publicConfig:{};
    const secretEntries=Object.entries(secrets);
    const publicConfigEntries=Object.entries(publicConfig);
    if(!PROVIDERS.has(providerKey)
       ||!['sandbox','live'].includes(environment)
       ||!['redirect','embedded','api'].includes(checkoutMode)
       ||supportedCurrencies.length<1
       ||supportedCurrencies.length>20
       ||supportedCurrencies.some(value=>!/^[A-Z]{3}$/.test(value))
       ||secretEntries.length>20
       ||secretEntries.some(([key,value])=>
         !/^[a-z][A-Za-z0-9]{1,80}$/.test(key)
         ||typeof value!=='string'
         ||value.length<1
         ||value.length>8192
       )
       ||publicConfigEntries.length>10
       ||publicConfigEntries.some(([key,value])=>
         !PUBLIC_CONFIG_KEYS.has(key)
         ||typeof value!=='string'
         ||value.trim().length<1
         ||value.length>240
         ||/[\u0000-\u001f\u007f]/.test(value)
       )){
      return NextResponse.json({error:'بيانات الاعتماد غير صالحة'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/payment-provider-admin`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          providerKey,
          environment,
          checkoutMode,
          supportedCurrencies,
          enabled:body.enabled!==false,
          publicConfig,
          secrets
        }),
        cache:'no-store'
      }
    );
    const text=await response.text();
    let result;
    try{result=JSON.parse(text)}catch{result={}}
    if(!response.ok){
      return NextResponse.json({
        error:providerError(result?.error)
      },{status:response.status});
    }
    return NextResponse.json({success:true,data:result});
  }catch{
    return NextResponse.json({error:'تعذر حفظ بيانات الاعتماد'},{status:500});
  }
}

function providerError(code){
  const messages={
    forbidden:'ليس لديك صلاحية إدارة وسائل الدفع',
    platform_subject_not_found:'تعذر توثيق هوية منفّذ التغيير',
    invalid_credentials_payload:'بيانات الربط غير مكتملة أو غير صالحة',
    credential_store_rejected:'رُفض الحفظ الآمن؛ عند تغيير البيئة أعد إدخال كل المعرّفات والمفاتيح المحفوظة',
    payload_too_large:'حجم بيانات الربط أكبر من الحد المسموح',
    unauthorized:'انتهت الجلسة'
  };
  return messages[code]||'تعذر حفظ بيانات الاعتماد';
}
