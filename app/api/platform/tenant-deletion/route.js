import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=8*1024;
const MAX_RESPONSE_BYTES=128*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const maxDuration=30;

export async function GET(request){
  try{
    const token=await accessToken();
    if(!token)return fail('انتهت جلسة الدخول','authentication_required',401);
    const tenantId=clean(request.nextUrl.searchParams.get('tenantId'),64);
    if(!UUID.test(tenantId)){
      return fail('معرّف المنشأة غير صالح','tenant_id_invalid',400);
    }
    const data=await rpc(token,'v1_platform_tenant_deletion_preview',{
      p_tenant_id:tenantId
    });
    if(!validPreview(data,tenantId)){
      return fail(
        'تعذر التحقق من معاينة الحذف؛ لم يتم لمس أي بيانات',
        'tenant_deletion_preview_response_invalid',503
      );
    }
    return privateJson({success:true,data});
  }catch(error){return unexpected(error);}
}

export async function POST(request){
  try{
    if(!sameOrigin(request)){
      return fail('تعذر التحقق من مصدر الطلب','request_origin_invalid',403);
    }
    const token=await accessToken();
    if(!token)return fail('انتهت جلسة الدخول','authentication_required',401);
    const bodyResult=await limitedJson(request);
    if(bodyResult.error)return bodyResult.error;
    const body=bodyResult.value;
    if(body.action!=='delete'){
      return fail('الإجراء غير مدعوم','tenant_deletion_action_invalid',400);
    }
    const tenantId=clean(body.tenantId,64);
    const digest=clean(body.previewDigest,64).toLowerCase();
    const confirmation=clean(body.confirmation,120);
    const reason=clean(body.reason,500);
    const idempotencyKey=clean(body.idempotencyKey,64);
    if(!UUID.test(tenantId)||!UUID.test(idempotencyKey)){
      return fail('بيانات عملية الحذف غير صالحة','tenant_deletion_payload_invalid',400);
    }
    if(!/^[a-f0-9]{64}$/.test(digest)){
      return fail('انتهت صلاحية المعاينة؛ أعد فتح نافذة الحذف','tenant_deletion_preview_invalid',409);
    }
    if(reason.length<8){
      return fail('اكتب سببًا واضحًا للحذف','tenant_deletion_reason_required',400);
    }
    const data=await rpc(token,'v1_platform_tenant_delete',{
      p_tenant_id:tenantId,
      p_preview_digest:digest,
      p_confirmation:confirmation,
      p_reason:reason,
      p_idempotency_key:idempotencyKey
    });
    if(!validResult(data,tenantId)){
      return fail(
        'تعذر التحقق من نتيجة الحذف؛ حدّث قائمة المنشآت قبل إعادة المحاولة',
        'tenant_deletion_response_invalid',503
      );
    }
    return privateJson({success:true,data});
  }catch(error){return unexpected(error);}
}

async function rpc(token,name,body){
  let response;
  try{
    response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'content-type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:AbortSignal.timeout(25_000)
    });
  }catch(error){
    if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)){
      throw new PublicError(
        'انتهت مهلة العملية. حدّث القائمة للتحقق من الحالة قبل إعادة المحاولة.',
        'tenant_deletion_timeout',503
      );
    }
    throw error;
  }
  const text=await boundedResponseText(response,MAX_RESPONSE_BYTES);
  let data={};
  try{data=text?JSON.parse(text):{};}catch{
    throw new PublicError(
      'استجابة خدمة الحذف غير صالحة؛ لم يتم تأكيد أي حذف',
      'tenant_deletion_gateway_invalid',503
    );
  }
  if(!response.ok){
    const source=String(data?.message||data?.error||data?.detail||'request_failed');
    throw new RpcError(source,response.status,String(data?.code||''));
  }
  return data;
}

function validPreview(value,tenantId){
  if(!value||Array.isArray(value)||typeof value!=='object')return false;
  return value.previewVersion===1
    &&String(value.tenant?.id||'').toLowerCase()===tenantId.toLowerCase()
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.tenant?.slug||''))
    &&/^[a-f0-9]{64}$/.test(String(value.previewDigest||''))
    &&typeof value.canDelete==='boolean'
    &&Array.isArray(value.blockers)
    &&value.counts&&typeof value.counts==='object'&&!Array.isArray(value.counts)
    &&value.confirmationPhrase===`حذف ${value.tenant.slug}`;
}

function validResult(value,tenantId){
  return Boolean(value)&&!Array.isArray(value)&&typeof value==='object'
    &&value.deleted===true
    &&String(value.tenantId||'').toLowerCase()===tenantId.toLowerCase()
    &&UUID.test(String(value.receiptId||''))
    &&value.registrationReleased===true
    &&value.authUserDeleted===false;
}

function sameOrigin(request){
  const site=String(request.headers.get('sec-fetch-site')||'').toLowerCase();
  if(site&&site!=='same-origin')return false;
  const origin=request.headers.get('origin');
  if(!origin)return false;
  try{
    const source=new URL(origin);
    const target=new URL(request.url);
    const forwardedHost=String(request.headers.get('x-forwarded-host')||'')
      .split(',')[0].trim().toLowerCase();
    const targetHost=(forwardedHost||target.host).toLowerCase();
    const sourceHost=source.host.toLowerCase();
    if(!trustedControlHost(sourceHost)||!trustedControlHost(targetHost))return false;
    return sourceHost===targetHost&&(
      source.protocol==='https:'
      ||source.protocol==='http:'&&isLocalHost(source.hostname)
    );
  }catch{return false;}
}

function trustedControlHost(value){
  const hostname=String(value||'').split(':')[0].toLowerCase();
  return ['odeir.com','www.odeir.com','staging.odeir.com'].includes(hostname)
    ||isLocalHost(hostname);
}

function isLocalHost(value){
  return ['localhost','127.0.0.1'].includes(String(value||'').toLowerCase());
}

async function limitedJson(request){
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY_BYTES){
    return {error:fail('حجم الطلب أكبر من المسموح','request_too_large',413)};
  }
  const text=await boundedRequestText(request,MAX_BODY_BYTES);
  if(text===null){
    return {error:fail('حجم الطلب أكبر من المسموح','request_too_large',413)};
  }
  try{
    const value=JSON.parse(text);
    if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();
    return {value};
  }catch{return {error:fail('بيانات الطلب غير صالحة','invalid_json',400)};}
}

async function boundedRequestText(request,maxBytes){
  if(!request.body)return '';
  const reader=request.body.getReader();
  const chunks=[];let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){await reader.cancel();return null;}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const merged=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

async function boundedResponseText(response,maxBytes){
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>maxBytes)throw new Error('response_too_large');
  if(!response.body)return '';
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){await reader.cancel();throw new Error('response_too_large');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const merged=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

function translated(source,status){
  if(source.includes('forbidden'))return 403;
  if(source.includes('not_found'))return 404;
  if(source.includes('preview_stale')||source.includes('idempotency_conflict'))return 409;
  if(source.includes('_blocked')||source.includes('protected_'))return 409;
  if(source.includes('_invalid')||source.includes('_required')||source.includes('_mismatch'))return 400;
  return status===401?401:503;
}

function translatedMessage(source){
  const messages={
    forbidden:'الحذف النهائي متاح لمالك المنصة فقط',
    tenant_not_found:'المنشأة غير موجودة أو تم حذفها بالفعل',
    tenant_deletion_preview_stale:'تغيرت بيانات المنشأة بعد المعاينة؛ راجع الأعداد وأكد من جديد',
    tenant_deletion_blocked:'الحذف متوقف لوجود بيانات محمية؛ افتح المعاينة لمعرفة السبب',
    tenant_deletion_confirmation_mismatch:'اكتب عبارة التأكيد كما تظهر بالضبط',
    tenant_deletion_reason_required:'اكتب سببًا واضحًا للحذف',
    tenant_deletion_idempotency_conflict:'تعارض مفتاح العملية مع منشأة أخرى؛ أعد فتح النافذة',
    protected_tenant_deletion_forbidden:'هذه المنشأة محمية من الحذف النهائي',
    tenant_deletion_failed:'تعذر إكمال الحذف؛ تم التراجع عن العملية كاملة'
  };
  const key=Object.keys(messages).find(item=>source.includes(item));
  return key?messages[key]:'تعذر تنفيذ الحذف؛ لم يتم تأكيد أي تغيير';
}

function unexpected(error){
  if(error instanceof PublicError){
    return fail(error.publicMessage,error.code,error.status);
  }
  if(error instanceof RpcError){
    console.error('platform_tenant_deletion_rpc_failed',{
      publicCode:error.code,databaseCode:error.databaseCode,
      responseStatus:error.responseStatus
    });
    return fail(translatedMessage(error.source),error.code,error.status);
  }
  console.error('platform_tenant_deletion_failed',{
    errorName:error instanceof Error?error.name:'UnknownError'
  });
  return fail('تعذر الوصول إلى خدمة الحذف؛ لم يتم تأكيد أي تغيير','service_unavailable',503);
}

function fail(message,code,status){
  return privateJson({success:false,error:message,code},{status});
}

function privateJson(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','private, no-store, no-cache, max-age=0, must-revalidate');
  response.headers.set('CDN-Cache-Control','no-store');
  response.headers.set('Vercel-CDN-Cache-Control','no-store');
  response.headers.set('Pragma','no-cache');
  response.headers.set('Expires','0');
  response.headers.set('Referrer-Policy','no-referrer');
  return response;
}

function clean(value,max){
  return String(value??'').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);
}

class RpcError extends Error{
  constructor(source,responseStatus,databaseCode){
    super(source);
    this.source=source;
    this.code=Object.keys({
      forbidden:1,tenant_not_found:1,tenant_deletion_preview_stale:1,
      tenant_deletion_blocked:1,tenant_deletion_confirmation_mismatch:1,
      tenant_deletion_reason_required:1,tenant_deletion_idempotency_conflict:1,
      protected_tenant_deletion_forbidden:1,tenant_deletion_failed:1
    }).find(item=>source.includes(item))||'tenant_deletion_failed';
    this.status=translated(source,responseStatus);
    this.responseStatus=responseStatus;
    this.databaseCode=databaseCode||'unknown';
  }
}

class PublicError extends Error{
  constructor(publicMessage,code,status){
    super(code);this.publicMessage=publicMessage;this.code=code;this.status=status;
  }
}
