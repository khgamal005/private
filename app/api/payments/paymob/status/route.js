import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../../lib/config';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$/i;
const ATTEMPT_STATUSES=new Set([
  'prepared','creating_intention','intention_created','pending','paid','failed',
  'unknown','quarantined','refunded','cancelled'
]);
const ORDER_STATUSES=new Set([
  'pending_payment','paid','in_progress','completed','cancelled','refunded'
]);
const PAYMENT_STATUSES=new Set(['pending','paid','failed','refunded','waived']);
const RESULT_CODES=new Set([
  'paid','review_required','issuer_declined_retry_available',
  'payment_expired','payment_failed','payment_cancelled'
]);
const MAX_BODY_BYTES=4*1024;
const MAX_UPSTREAM_BYTES=64*1024;

export async function POST(request){
  try{
    if(!sameOrigin(request)){
      return json({error:'تعذر التحقق من مصدر الطلب'},{status:403});
    }
    const contentType=String(request.headers.get('content-type')||'')
      .split(';',1)[0].trim().toLowerCase();
    if(contentType!=='application/json'){
      return json({error:'نوع بيانات متابعة الدفع غير مدعوم'},{status:415});
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});

    const parsed=await limitedJson(request);
    if(parsed.tooLarge){
      return json({error:'بيانات متابعة الدفع أكبر من الحد المسموح'},{status:413});
    }
    if(!parsed.value){
      return json({error:'بيانات متابعة الدفع غير صالحة'},{status:400});
    }
    const slug=String(parsed.value.slug||'').trim().toLowerCase();
    const attemptId=String(parsed.value.attemptId||'').trim();
    if(!SLUG.test(slug)||!UUID.test(attemptId)){
      return json({error:'معرّف متابعة الدفع غير صالح'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v1_tenant_paymob_checkout_status`,
      {
        method:'POST',
        redirect:'error',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify({p_slug:slug,p_attempt_id:attemptId}),
        cache:'no-store',
        signal:AbortSignal.timeout(10000)
      }
    );
    const upstream=await readTextLimited(response,MAX_UPSTREAM_BYTES);
    if(upstream.tooLarge){
      return json({
        error:'تعذر التحقق من استجابة حالة الدفع',
        errorCode:'paymob_status_unavailable'
      },{status:502});
    }
    let result;
    try{result=JSON.parse(upstream.text)}catch{result={}}
    if(!response.ok){
      const code=safeErrorCode(
        result.message||result.error,
        'paymob_status_unavailable'
      );
      return json({error:statusError(code),errorCode:code},{
        status:[400,401,403,404,429].includes(response.status)
          ?response.status
          :503
      });
    }

    const attemptStatus=safeEnum(result.attemptStatus,ATTEMPT_STATUSES,'unknown');
    const orderStatus=safeEnum(result.orderStatus,ORDER_STATUSES,'pending_payment');
    const paymentStatus=safeEnum(result.paymentStatus,PAYMENT_STATUSES,'pending');
    const terminal=result.terminal===true;
    const resultCode=safeEnum(result.resultCode,RESULT_CODES,null);
    const retryAllowed=resultCode==='issuer_declined_retry_available'
      &&result.retryAllowed===true;
    return json({
      attemptId:safeUuid(result.attemptId)||attemptId,
      orderId:safeUuid(result.orderId),
      orderNumber:safeString(result.orderNumber,80),
      orderKind:['addon','service'].includes(result.orderKind)?result.orderKind:null,
      attemptStatus,
      orderStatus,
      paymentStatus,
      terminal,
      resultCode,
      retryAllowed,
      refreshAfterMs:terminal||resultCode==='issuer_declined_retry_available'
        ?null
        :safeRefresh(result.refreshAfterMs)
    });
  }catch(error){
    return json({
      error:error instanceof Error&&error.name==='TimeoutError'
        ?'تأخر التحقق من حالة الدفع؛ سنحاول مرة أخرى'
        :'تعذر التحقق من حالة الدفع حاليًا',
      errorCode:'paymob_status_unavailable'
    },{status:503});
  }
}

async function limitedJson(request){
  const {tooLarge,text:raw}=await readTextLimited(request,MAX_BODY_BYTES);
  if(tooLarge)return {tooLarge:true,value:null};
  try{
    const value=JSON.parse(raw);
    return {
      tooLarge:false,
      value:value&&typeof value==='object'&&!Array.isArray(value)?value:null
    };
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

function safeUuid(value){
  const result=String(value||'');
  return UUID.test(result)?result:null;
}

function safeString(value,maxLength){
  const result=String(value||'').trim();
  return result&&result.length<=maxLength
    &&!/[\u0000-\u001f\u007f<>]/.test(result)?result:null;
}

function safeEnum(value,allowed,fallback){
  const result=String(value||'');
  return allowed.has(result)?result:fallback;
}

function safeErrorCode(value,fallback){
  const result=String(value||'').trim();
  return /^[a-z][a-z0-9_]{0,119}$/.test(result)?result:fallback;
}

function safeRefresh(value){
  const result=Number(value);
  if(!Number.isFinite(result))return 3000;
  return Math.min(15000,Math.max(1500,Math.round(result)));
}

function statusError(code){
  const messages={
    forbidden:'ليس لديك صلاحية متابعة هذا الدفع',
    tenant_not_found:'المنشأة غير موجودة',
    paymob_checkout_attempt_not_found:'لم نجد محاولة الدفع لهذه المنشأة',
    paymob_attempt_not_found:'لم نجد محاولة الدفع لهذه المنشأة',
    invalid_paymob_attempt:'معرّف متابعة الدفع غير صالح'
  };
  return messages[code]||'تعذر التحقق من حالة الدفع حاليًا';
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
