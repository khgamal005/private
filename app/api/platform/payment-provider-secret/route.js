import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const PROVIDERS=new Set(['tamara','paymob','paypal']);
const MAX_BODY_BYTES=16*1024;
const ADMIN_UPSTREAM_TIMEOUT_MS=15_000;
const PUBLIC_CONFIG_KEYS=new Set([
  'merchantId','merchantAccountId','integrationId','applePayIntegrationId',
  'integrationPath','webhookId','region'
]);
const PAYMOB_PUBLIC_CONFIG_KEYS=new Set([
  'merchantAccountId','integrationPath','integrationId',
  'applePayIntegrationId','region'
]);
const PAYMOB_SECRET_KEYS=new Set([
  'secretKey','publicKey','hmacSecret','apiKey'
]);

function positiveSafeInteger(value){
  if(!/^[1-9]\d*$/.test(value))return false;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>0;
}

function validProviderConfig(
  providerKey,environment,checkoutMode,supportedCurrencies,publicConfig,
  secrets,secretEntries
){
  if(providerKey!=='paymob')return true;
  const configKeys=Object.keys(publicConfig);
  const integrationPath=publicConfig.integrationPath;
  const applePayIntegrationId=publicConfig.applePayIntegrationId;
  return checkoutMode==='redirect'
    &&supportedCurrencies.length===1
    &&supportedCurrencies[0]==='SAR'
    &&configKeys.every(key=>PAYMOB_PUBLIC_CONFIG_KEYS.has(key))
    &&positiveSafeInteger(publicConfig.merchantAccountId||'')
    &&positiveSafeInteger(publicConfig.integrationId||'')
    &&['intention','quicklink'].includes(integrationPath)
    &&Object.prototype.hasOwnProperty.call(
      publicConfig,'applePayIntegrationId'
    )
    &&(applePayIntegrationId===null||(
      integrationPath==='quicklink'
      &&positiveSafeInteger(applePayIntegrationId)
      &&applePayIntegrationId!==publicConfig.integrationId
    ))
    &&publicConfig.region==='ksa'
    &&validPaymobLiveCredentials(environment,integrationPath,secrets)
    &&secretEntries.every(entry=>PAYMOB_SECRET_KEYS.has(entry[0]));
}

function validPaymobLiveCredentials(environment,integrationPath,secrets){
  if(environment!=='live'||integrationPath!=='intention')return true;
  const secretKey=secrets.secretKey;
  const publicKey=secrets.publicKey;
  return (secretKey===undefined||(
      typeof secretKey==='string'&&/^sklive/i.test(secretKey)
    ))
    &&(publicKey===undefined||(
      typeof publicKey==='string'&&/^pklive/i.test(publicKey)
    ));
}

export async function POST(request){
  try{
    if(!sameOrigin(request)){
      return json({error:'تعذر التحقق من مصدر الطلب'},{status:403});
    }
    const contentType=String(request.headers.get('content-type')||'')
      .split(';',1)[0].trim().toLowerCase();
    if(contentType!=='application/json'){
      return json({error:'نوع بيانات الطلب غير مدعوم'},{status:415});
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});
    const {text:rawBody,tooLarge}=await readTextLimited(
      request,MAX_BODY_BYTES
    );
    if(tooLarge){
      return json(
        {error:providerError('payload_too_large')},
        {status:413}
      );
    }
    let body;
    try{body=JSON.parse(rawBody)}catch{
      return json({error:'بيانات الاعتماد غير صالحة'},{status:400});
    }
    if(!body||typeof body!=='object'||Array.isArray(body)){
      return json({error:'بيانات الاعتماد غير صالحة'},{status:400});
    }
    const providerKey=String(body.providerKey||'');
    const environment=String(body.environment||'');
    const checkoutMode=String(body.checkoutMode||'');
    const supportedCurrencies=Array.isArray(body.supportedCurrencies)
      ?body.supportedCurrencies.map(value=>String(value).trim().toUpperCase())
      :[];
    const secrets=body.secrets&&typeof body.secrets==='object'
      &&!Array.isArray(body.secrets)?body.secrets:{};
    const submittedPublicConfig=body.publicConfig
      &&typeof body.publicConfig==='object'
      &&!Array.isArray(body.publicConfig)?body.publicConfig:{};
    const publicConfig=Object.fromEntries(
      Object.entries(submittedPublicConfig).map(([key,value])=>[
        key,typeof value==='string'?value.trim():value
      ])
    );
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
         ||(key==='applePayIntegrationId'&&value===null
           ?false
           :typeof value!=='string'
             ||value.trim().length<1
             ||value.length>240
             ||/[\u0000-\u001f\u007f]/.test(value))
       )
       ||!validProviderConfig(
         providerKey,environment,checkoutMode,supportedCurrencies,
         publicConfig,secrets,secretEntries
       )){
      return json({error:'بيانات الاعتماد غير صالحة'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/payment-provider-admin`,
      {
        method:'POST',
        redirect:'error',
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
        cache:'no-store',
        signal:AbortSignal.timeout(ADMIN_UPSTREAM_TIMEOUT_MS)
      }
    );
    const upstreamBody=await readTextLimited(response,MAX_BODY_BYTES);
    if(upstreamBody.tooLarge){
      return json({error:'تعذر التحقق من نتيجة حفظ بيانات الاعتماد'},{status:502});
    }
    const text=upstreamBody.text;
    let result;
    try{result=JSON.parse(text)}catch{result={}}
    if(!response.ok){
      return json({
        error:providerError(result?.error)
      },{status:response.status});
    }
    return json({success:true,data:result});
  }catch(error){
    const timedOut=error instanceof Error&&error.name==='TimeoutError';
    return json({
      error:timedOut
        ?'تأخر حفظ بيانات الاعتماد؛ تحقق من حالتها قبل إعادة الإرسال'
        :'تعذر حفظ بيانات الاعتماد'
    },{status:timedOut?504:500});
  }
}

function json(body,init={}){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','no-store');
  response.headers.set('X-Content-Type-Options','nosniff');
  return response;
}

function sameOrigin(request){
  const site=String(request.headers.get('sec-fetch-site')||'').toLowerCase();
  if(site&&site!=='same-origin')return false;
  const origin=request.headers.get('origin');
  if(!origin)return site==='same-origin';
  try{
    const source=new URL(origin);
    const target=requestOrigin(request);
    return Boolean(target)
      &&source.username===''&&source.password===''
      &&source.pathname==='/'&&!source.search&&!source.hash
      &&source.origin===target;
  }catch{return false;}
}

function requestOrigin(request){
  const target=new URL(request.url);
  const forwardedHost=String(request.headers.get('x-forwarded-host')||'').trim();
  const forwardedProto=String(request.headers.get('x-forwarded-proto')||'')
    .trim().toLowerCase();
  if(forwardedHost||forwardedProto){
    if(!forwardedHost||!forwardedProto||forwardedHost.includes(',')
       ||forwardedProto.includes(',')
       ||!['http','https'].includes(forwardedProto)
       ||!/^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::\d{1,5})?$/i.test(forwardedHost)){
      return null;
    }
    return `${forwardedProto}://${forwardedHost.toLowerCase()}`;
  }
  return ['https:','http:'].includes(target.protocol)?target.origin:null;
}

async function readTextLimited(request,maxBytes){
  if(!request.body)return {text:'',tooLarge:false};
  const reader=request.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel().catch(()=>{});
        return {text:'',tooLarge:true};
      }
      chunks.push(decoder.decode(value,{stream:true}));
    }
    chunks.push(decoder.decode());
    return {text:chunks.join(''),tooLarge:false};
  }finally{
    reader.releaseLock();
  }
}

function providerError(code){
  const messages={
    forbidden:'ليس لديك صلاحية إدارة وسائل الدفع',
    platform_subject_not_found:'تعذر توثيق هوية منفّذ التغيير',
    invalid_credentials_payload:'بيانات الربط غير مكتملة أو غير صالحة',
    credential_store_rejected:'تعذر حفظ إعدادات الدفع الآمنة. لم يُحفظ أي تغيير؛ حدّث الصفحة وأعد المحاولة',
    live_credentials_invalid:'مفاتيح Paymob لا تطابق وضع Live. استخدم Secret Key الذي يبدأ بـ sklive وPublic Key الذي يبدأ بـ pklive',
    payload_too_large:'حجم بيانات الربط أكبر من الحد المسموح',
    unauthorized:'انتهت الجلسة'
  };
  return messages[code]||'تعذر حفظ بيانات الاعتماد';
}
