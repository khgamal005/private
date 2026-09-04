import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../../lib/config';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$/i;
const IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{16,120}$/;
const MAX_BODY_BYTES=16*1024;
const MAX_UPSTREAM_BYTES=128*1024;
const PAYMOB_CHECKOUT_HOST='ksa.checkout.paymob.com';
const PAYMOB_QUICKLINK_HOST='ksa.paymob.com';
const PAYMOB_QUICKLINK_PATH='/api/ecommerce/payment-links/unrestricted';
const PAYMENT_OPTIONS=new Set(['hosted','card','apple_pay']);
const CHECKOUT_INPUT_KEYS=new Set([
  'slug','orderId','idempotencyKey','paymentOption','billingContact'
]);
const BILLING_CONTACT_KEYS=new Set([
  'firstName','lastName','email','phoneNumber'
]);

export async function POST(request){
  try{
    if(!sameOrigin(request)){
      return json({error:'تعذر التحقق من مصدر طلب الدفع'},{status:403});
    }
    const contentType=String(request.headers.get('content-type')||'')
      .split(';',1)[0].trim().toLowerCase();
    if(contentType!=='application/json'){
      return json({error:'نوع بيانات طلب الدفع غير مدعوم'},{status:415});
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});

    const parsed=await limitedJson(request);
    if(parsed.tooLarge){
      return json({error:'بيانات الدفع أكبر من الحد المسموح'},{status:413});
    }
    if(!parsed.value){
      return json({error:'بيانات طلب الدفع غير صالحة'},{status:400});
    }
    const input=checkoutInput(parsed.value);
    if(!input){
      return json({error:'تحقق من الاسم والبريد ورقم الجوال السعودي ثم أعد المحاولة'},{status:400});
    }

    const response=await fetch(`${SUPABASE_URL}/functions/v1/paymob-checkout`,{
      method:'POST',
      redirect:'error',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:JSON.stringify(input),
      cache:'no-store',
      signal:AbortSignal.timeout(30000)
    });
    const upstream=await readTextLimited(response,MAX_UPSTREAM_BYTES);
    if(upstream.tooLarge){
      return json({
        ok:false,error:'تعذر التحقق من استجابة بوابة الدفع',
        errorCode:'invalid_checkout_response',retryAllowed:false
      },{status:502});
    }
    let result;
    try{result=JSON.parse(upstream.text)}catch{result={}}

    if(!response.ok&&response.status!==202){
      const errorCode=safeErrorCode(
        result.error,
        'paymob_checkout_unavailable'
      );
      return json({
        ok:false,
        error:checkoutError(errorCode),
        errorCode,
        retryAllowed:result.retryAllowed===true,
        attemptId:safeUuid(result.attemptId)
      },{status:safeUpstreamStatus(response.status)});
    }

    const payload={
      ok:result.ok===true,
      status:String(result.status||''),
      attemptId:safeUuid(result.attemptId),
      orderId:safeUuid(result.orderId),
      orderNumber:safeString(result.orderNumber,80),
      checkoutFlow:['intention','quicklink'].includes(result.checkoutFlow)
        ?result.checkoutFlow
        :undefined,
      paymentOption:PAYMENT_OPTIONS.has(result.paymentOption)
        ?result.paymentOption
        :undefined,
      retryAllowed:result.retryAllowed===true
    };

    if(response.status===202||result.status==='unknown'){
      const attemptStatus=String(result.status||'unknown');
      const unknown=attemptStatus==='unknown';
      return json({
        ...payload,
        ok:false,
        status:attemptStatus,
        error:unknown
          ?'لم تُحسم نتيجة تهيئة الدفع بعد. سنراجع الحالة بأمان دون إنشاء عملية جديدة.'
          :'توجد محاولة دفع قائمة لهذا الطلب. سنعرض حالتها دون إنشاء عملية مكررة.',
        errorCode:unknown
          ?'payment_initialization_unknown'
          :'payment_attempt_already_active',
        retryAllowed:false
      },{status:202});
    }

    const checkoutUrl=verifiedCheckoutUrl(result.checkoutUrl);
    if(!payload.attemptId||!payload.orderId||!checkoutUrl){
      return json({
        ok:false,
        error:'تعذر التحقق من رابط Paymob الآمن',
        errorCode:'invalid_checkout_response',
        retryAllowed:false
      },{status:502});
    }

    return json({
      ...payload,
      ok:true,
      status:'checkout_ready',
      checkoutUrl
    },{status:response.status===201?201:200});
  }catch(error){
    const timedOut=error instanceof Error&&error.name==='TimeoutError';
    return json({
      ok:false,
      error:timedOut
        ?'استغرقت تهيئة الدفع وقتًا أطول من المتوقع. لا تُعد المحاولة فورًا؛ حدّث سجل الطلب أولًا.'
        :'تعذر الاتصال بخدمة الدفع حاليًا',
      errorCode:timedOut?'checkout_gateway_timeout':'checkout_gateway_unavailable',
      retryAllowed:false
    },{status:timedOut?504:500});
  }
}

async function limitedJson(request){
  const {tooLarge,text:raw}=await readTextLimited(request,MAX_BODY_BYTES);
  if(tooLarge)return {tooLarge:true,value:null};
  try{
    const value=JSON.parse(raw);
    return {tooLarge:false,value};
  }catch{return {tooLarge:false,value:null};}
}

async function readTextLimited(request,maxBytes){
  const contentLength=request.headers.get('content-length');
  if(contentLength&&/^\d+$/.test(contentLength)
     &&Number(contentLength)>maxBytes){
    await request.body?.cancel('request_body_too_large').catch(()=>{});
    return {tooLarge:true,text:''};
  }
  if(!request.body)return {tooLarge:false,text:''};

  const reader=request.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0;
  let text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done){
        text+=decoder.decode();
        return {tooLarge:false,text};
      }
      bytes+=value.byteLength;
      if(bytes>maxBytes){
        await reader.cancel('request_body_too_large').catch(()=>{});
        return {tooLarge:true,text:''};
      }
      text+=decoder.decode(value,{stream:true});
    }
  }finally{
    reader.releaseLock();
  }
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

function checkoutInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  if(Object.keys(body).some(key=>!CHECKOUT_INPUT_KEYS.has(key)))return null;
  const slug=String(body.slug||'').trim().toLowerCase();
  const orderId=String(body.orderId||'').trim();
  const idempotencyKey=String(body.idempotencyKey||'').trim();
  const paymentOption=String(body.paymentOption||'hosted').trim().toLowerCase();
  const contact=body.billingContact;
  if(!SLUG.test(slug)||!UUID.test(orderId)
     ||!IDEMPOTENCY_KEY.test(idempotencyKey)
     ||!PAYMENT_OPTIONS.has(paymentOption)
     ||!contact||typeof contact!=='object'||Array.isArray(contact))return null;
  if(Object.keys(contact).some(key=>!BILLING_CONTACT_KEYS.has(key)))return null;

  const firstName=cleanText(contact.firstName,2,100);
  const lastName=cleanText(contact.lastName,2,100);
  const email=String(contact.email||'').trim().toLowerCase();
  const phoneNumber=saudiPhone(contact.phoneNumber);
  if(!firstName||!lastName||!validEmail(email)||!phoneNumber)return null;

  return {
    slug,
    orderId,
    idempotencyKey,
    paymentOption,
    billingContact:{firstName,lastName,email,phoneNumber}
  };
}

function cleanText(value,min,max){
  const result=String(value||'').trim().replace(/\s+/g,' ');
  if(result.length<min||result.length>max||/[\u0000-\u001f\u007f<>]/.test(result))return null;
  return result;
}

function validEmail(value){
  return value.length<=254
    &&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    &&!/[\u0000-\u001f\u007f]/.test(value);
}

function saudiPhone(value){
  const normalized=String(value||'').trim().replace(/[\s()-]/g,'');
  if(/^05[0-9]{8}$/.test(normalized))return `+966${normalized.slice(1)}`;
  return /^\+9665[0-9]{8}$/.test(normalized)?normalized:null;
}

function verifiedCheckoutUrl(value){
  try{
    const url=new URL(String(value||''));
    const keys=[...url.searchParams.keys()];
    if(url.protocol!=='https:'||url.port||url.hash
       ||url.username||url.password)return null;
    const unified=url.hostname===PAYMOB_CHECKOUT_HOST
      &&url.pathname==='/'
      &&keys.length===2&&new Set(keys).size===2
      &&url.searchParams.getAll('publicKey').length===1
      &&url.searchParams.getAll('clientSecret').length===1
      &&Boolean(url.searchParams.get('publicKey'))
      &&Boolean(url.searchParams.get('clientSecret'));
    const quicklinkToken=url.searchParams.get('token')||'';
    const quicklinkUnrestricted=url.hostname===PAYMOB_QUICKLINK_HOST
      &&url.pathname===PAYMOB_QUICKLINK_PATH
      &&keys.length===1&&keys[0]==='token'
      &&url.searchParams.getAll('token').length===1;
    const quicklinkFlash=url.hostname===PAYMOB_QUICKLINK_HOST
      &&['/flash','/flash/'].includes(url.pathname)
      &&keys.length===2&&new Set(keys).size===2
      &&url.searchParams.getAll('token').length===1
      &&url.searchParams.getAll('type').length===1
      &&url.searchParams.get('type')==='new';
    const quicklink=(quicklinkUnrestricted||quicklinkFlash)
      &&/^[A-Za-z0-9+/_=-]{16,8192}$/.test(quicklinkToken);
    if(!unified&&!quicklink)return null;
    return url.toString();
  }catch{return null;}
}

function safeUuid(value){
  const result=String(value||'');
  return UUID.test(result)?result:null;
}

function safeString(value,maxLength){
  const result=String(value||'').trim();
  return result&&result.length<=maxLength?result:null;
}

function safeErrorCode(value,fallback){
  const result=String(value||'').trim();
  return /^[a-z][a-z0-9_]{0,119}$/.test(result)?result:fallback;
}

function safeUpstreamStatus(status){
  return [400,401,403,404,409,422,429,502,503].includes(status)?status:502;
}

function checkoutError(code){
  const messages={
    forbidden:'ليس لديك صلاحية دفع هذا الطلب',
    tenant_not_found:'المنشأة غير موجودة',
    marketplace_order_not_found:'طلب الشراء غير موجود',
    marketplace_order_not_payable:'هذا الطلب لا يقبل الدفع في حالته الحالية',
    marketplace_payment_provider_mismatch:'هذا الطلب غير مخصص للدفع عبر Paymob',
    paymob_provider_not_ready:'Paymob غير جاهز للدفع حاليًا',
    paymob_tenant_rollout_required:'وسيلة الدفع غير مفعلة لهذه المنشأة حاليًا',
    paymob_tenant_not_enabled:'وسيلة الدفع غير مفعلة لهذه المنشأة حاليًا',
    paymob_rollout_not_enabled:'وسيلة الدفع غير مفعلة في بيئة التشغيل الحالية',
    paymob_readiness_evidence_stale:'أُوقفت Paymob مؤقتًا حتى إعادة التحقق من جاهزية التشغيل',
    order_review_hold:'الطلب قيد مراجعة حالة الدفع ولا يقبل محاولة جديدة الآن',
    paymob_order_payment_review_hold:'الطلب قيد مراجعة حالة الدفع ولا يقبل محاولة جديدة الآن',
    paymob_currency_not_supported:'عملة الطلب غير مدعومة عبر Paymob',
    paymob_checkout_attempt_unknown:'نتيجة محاولة سابقة غير محسومة؛ سنراجعها قبل السماح بمحاولة جديدة',
    payment_initialization_unknown:'نتيجة تهيئة الدفع غير محسومة؛ لا تبدأ عملية جديدة الآن',
    paymob_payment_option_invalid:'خيار الدفع المحدد غير صالح',
    paymob_payment_option_unavailable:'خيار الدفع المحدد غير متاح حاليًا',
    paymob_idempotency_payment_option_conflict:'محاولة الدفع الحالية مرتبطة بخيار دفع آخر',
    invalid_billing_contact:'تحقق من بيانات الاسم والبريد والجوال'
  };
  return messages[code]||'تعذر فتح صفحة الدفع الآمنة حاليًا';
}

function json(body,init={}){
  return NextResponse.json(body,{
    ...init,
    headers:{
      'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
      ...(init.headers||{})
    }
  });
}
