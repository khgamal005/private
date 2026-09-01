import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_REQUEST_BYTES=32*1024;
const MAX_UPSTREAM_BYTES=256*1024;
const RPC_TIMEOUT_MS=15_000;
const REQUEST_KEYS=new Set(['p_slug','p_action','p_payload']);

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

    const inbound=await readTextLimited(request,MAX_REQUEST_BYTES);
    if(inbound.tooLarge){
      return json({error:'بيانات الطلب أكبر من الحد المسموح'},{status:413});
    }
    let body;
    try{body=JSON.parse(inbound.text)}catch{
      return json({error:'بيانات الطلب غير صالحة'},{status:400});
    }
    if(!body||typeof body!=='object'||Array.isArray(body)
       ||Object.keys(body).some(key=>!REQUEST_KEYS.has(key))){
      return json({error:'بيانات الطلب غير صالحة'},{status:400});
    }

    const rpc=body.p_action==='submit_bank_transfer'
      ?'v2_tenant_marketplace_action'
      :'v2_tenant_service_marketplace_action';
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{
      method:'POST',
      redirect:'error',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:AbortSignal.timeout(RPC_TIMEOUT_MS)
    });
    const upstream=await readTextLimited(response,MAX_UPSTREAM_BYTES);
    if(upstream.tooLarge){
      return json({error:'تعذر التحقق من نتيجة العملية'},{status:502});
    }
    let data;
    try{data=JSON.parse(upstream.text)}catch{
      return json({error:'تعذر التحقق من نتيجة العملية'},{status:502});
    }
    if(!response.ok){
      const errorCode=safeErrorCode(data?.message||data?.error);
      return json({error:translate(errorCode),errorCode},{
        status:safeUpstreamStatus(response.status)
      });
    }
    return json({success:true,data});
  }catch(error){
    const timedOut=error instanceof Error&&error.name==='TimeoutError';
    return json({
      error:timedOut
        ?'تأخر تنفيذ العملية؛ حدّث الطلب قبل إعادة الإرسال'
        :'تعذر تنفيذ العملية'
    },{status:timedOut?504:503});
  }
}

async function readTextLimited(source,maxBytes){
  const contentLength=source.headers.get('content-length');
  if(contentLength&&/^\d+$/.test(contentLength)
     &&Number(contentLength)>maxBytes){
    await source.body?.cancel('body_too_large').catch(()=>{});
    return {tooLarge:true,text:''};
  }
  if(!source.body)return {tooLarge:false,text:''};
  const reader=source.body.getReader();
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
        await reader.cancel('body_too_large').catch(()=>{});
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

function safeErrorCode(value){
  const code=String(value||'').trim();
  return /^[a-z][a-z0-9_]{0,119}$/.test(code)
    ?code
    :'service_marketplace_unavailable';
}

function safeUpstreamStatus(status){
  return [400,401,403,404,409,422,429].includes(status)?status:503;
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لتنفيذ العملية',
    tenant_not_found:'المنشأة غير موجودة',
    marketplace_order_not_found:'طلب الشراء غير موجود',
    marketplace_order_not_payable:'هذا الطلب لا يقبل الدفع في حالته الحالية',
    marketplace_payment_provider_mismatch:'وسيلة الدفع لا تطابق الطلب',
    marketplace_payment_provider_unavailable:'وسيلة الدفع غير متاحة حاليًا',
    paymob_tenant_rollout_required:'وسيلة الدفع غير مفعلة لهذه المنشأة حاليًا',
    paymob_tenant_not_enabled:'وسيلة الدفع غير مفعلة لهذه المنشأة حاليًا',
    paymob_rollout_not_enabled:'وسيلة الدفع غير مفعلة في بيئة التشغيل الحالية',
    paymob_readiness_evidence_stale:'أُوقفت Paymob مؤقتًا حتى إعادة التحقق من جاهزية التشغيل',
    order_review_hold:'الطلب قيد مراجعة حالة الدفع ولا يقبل إجراءً جديدًا الآن',
    paymob_order_payment_review_hold:'الطلب قيد مراجعة حالة الدفع ولا يقبل إجراءً جديدًا الآن',
    paymob_order_cancel_requires_payment_resolution:'لا يمكن إلغاء طلب Paymob قبل حسم حالة عملية الدفع؛ تابع نفس العملية أو تواصل مع الدعم',
    bank_transfer_reference_required:'أدخل مرجع التحويل البنكي',
    bank_transfer_sender_required:'أدخل اسم المحوّل',
    bank_transfer_date_invalid:'تاريخ التحويل غير صالح',
    bank_transfer_already_approved:'تم اعتماد هذا التحويل بالفعل',
    service_marketplace_action_invalid:'إجراء متجر الخدمات غير مدعوم',
    service_package_invalid:'باقة الخدمة المختارة غير صالحة',
    service_package_not_found:'باقة الخدمة لم تعد متاحة',
    service_quote_required:'هذه الخدمة تحتاج طلب عرض سعر قبل الشراء',
    service_brief_invalid:'تفاصيل طلب الخدمة غير صالحة أو أطول من المسموح',
    service_review_invalid:'يمكن تقييم طلب خدمة مكتمل فقط وبدرجة من 1 إلى 5',
    service_review_unavailable:'لا يمكن إضافة تقييم لهذا الطلب حاليًا'
  };
  return messages[value]||'تعذر تنفيذ العملية';
}

function json(body,init={}){
  return NextResponse.json(body,{
    ...init,
    headers:{
      'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
      'X-Content-Type-Options':'nosniff',
      ...(init.headers||{})
    }
  });
}
