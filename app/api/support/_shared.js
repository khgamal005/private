import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../lib/config';
import {
  SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,
  SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE
} from '../../../lib/support-attachment-policy';

export const SUPPORT_JSON_LIMIT=64*1024;
export const SUPPORT_ATTACHMENT_LIMIT=10*1024*1024;
export const SUPPORT_UPSTREAM_TIMEOUT_MS=10*1000;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_TIMESTAMP=/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class SupportHttpError extends Error{
  constructor(code,status=400){
    super(code);
    this.code=code;
    this.status=status;
  }
}

export function failure(code,status=400){
  const headers={'cache-control':'no-store'};
  if(code==='support_rate_limit_exceeded')headers['retry-after']='60';
  return NextResponse.json({error:translate(code),code},{
    status,
    headers
  });
}

export function sameOrigin(request){
  const origin=request.headers.get('origin');
  if(!origin){
    return request.headers.get('sec-fetch-site')==='same-origin';
  }
  try{return new URL(origin).origin===new URL(request.url).origin;}catch{return false;}
}

export function supportUpstreamSignal(timeoutMs=SUPPORT_UPSTREAM_TIMEOUT_MS){
  return AbortSignal.timeout(timeoutMs);
}

export async function sessionToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

export function uuid(value,{required=false}={}){
  const normalized=String(value??'').trim();
  if(!normalized&&!required)return null;
  if(!UUID.test(normalized))throw new SupportHttpError('invalid_ticket_id');
  return normalized.toLowerCase();
}

export function slug(value){
  const normalized=String(value??'').trim().toLowerCase();
  if(!SLUG.test(normalized)||normalized.length>100){
    throw new SupportHttpError('invalid_slug');
  }
  return normalized;
}

export function text(value,{required=false,min=0,max=4000}={}){
  const normalized=String(value??'').trim();
  if(required&&normalized.length<Math.max(1,min)){
    throw new SupportHttpError('required_field_missing');
  }
  if(normalized.length>max)throw new SupportHttpError('field_too_long');
  return normalized||null;
}

export function integer(value,{required=false,min=0,max=Number.MAX_SAFE_INTEGER}={}){
  if((value===null||value===undefined||value==='')&&!required)return null;
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max){
    throw new SupportHttpError('invalid_number');
  }
  return parsed;
}

export function isoTimestamp(value,{required=false}={}){
  const normalized=String(value??'').trim();
  if(!normalized&&!required)return null;
  const match=normalized.length<=40?ISO_TIMESTAMP.exec(normalized):null;
  const calendarDate=match?`${match[1]}-${match[2]}-${match[3]}`:null;
  const parsed=match?Date.parse(normalized):Number.NaN;
  const parsedCalendar=calendarDate?Date.parse(`${calendarDate}T00:00:00Z`):Number.NaN;
  if(!match||!Number.isFinite(parsed)||!Number.isFinite(parsedCalendar)
     ||new Date(parsedCalendar).toISOString().slice(0,10)!==calendarDate){
    throw new SupportHttpError('invalid_timestamp');
  }
  return normalized;
}

export function oneOf(value,allowed,{required=false}={}){
  const normalized=String(value??'').trim();
  if(!normalized&&!required)return null;
  if(!allowed.has(normalized))throw new SupportHttpError('invalid_value');
  return normalized;
}

export function plainObject(value){
  if(value===null||value===undefined)return {};
  if(typeof value!=='object'||Array.isArray(value)){
    throw new SupportHttpError('invalid_payload');
  }
  return value;
}

export async function jsonBody(request){
  const contentType=String(request.headers.get('content-type')||'')
    .split(';',1)[0]
    .trim()
    .toLowerCase();
  if(contentType!=='application/json'){
    throw new SupportHttpError('unsupported_media_type',415);
  }
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>SUPPORT_JSON_LIMIT){
    throw new SupportHttpError('request_too_large',413);
  }
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>SUPPORT_JSON_LIMIT){
    throw new SupportHttpError('request_too_large',413);
  }
  try{return plainObject(JSON.parse(raw||'{}'));}
  catch(error){
    if(error instanceof SupportHttpError)throw error;
    throw new SupportHttpError('invalid_json');
  }
}

export async function supportRpc(token,name,body){
  let response;
  try{
    response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:supportUpstreamSignal()
    });
  }catch(error){
    const timedOut=error instanceof Error
      &&['AbortError','TimeoutError'].includes(error.name);
    console.error('[support-rpc-network-failure]',{
      name,
      errorName:error instanceof Error?error.name:'UnknownError',
      timedOut
    });
    throw new SupportHttpError(
      timedOut?'support_upstream_timeout':'support_upstream_unavailable',
      timedOut?504:502
    );
  }
  const raw=await response.text();
  let data=null;
  try{data=raw?JSON.parse(raw):null;}catch{data=null;}
  if(response.ok)return data;
  const code=databaseCode(data)||(
    response.status===401?'authentication_required':
      response.status===403?'forbidden':'support_request_failed'
  );
  const status=statusFor(code,response.status);
  console.error('[support-rpc-failure]',{name,status:response.status,code});
  throw new SupportHttpError(code,status);
}

function databaseCode(data){
  const source=String(data?.message||data?.hint||data?.details||'').trim();
  const known=[
    'authentication_required','forbidden','tenant_not_found','support_ticket_not_found',
    'support_message_not_found','support_attachment_not_found','support_conflict',
    'support_ticket_closed','support_reopen_window_expired','invalid_support_action',
    'invalid_support_status','invalid_support_transition','invalid_support_priority',
    'invalid_support_impact','invalid_support_module','invalid_attachment','attachment_not_ready',
    'attachment_upload_expired','assignee_not_found','assignee_not_allowed','title_required',
    'description_required','message_required','duplicate_support_request','support_queue_invalid',
    'support_assignee_invalid','support_attachment_count_limit',
    'support_attachment_extension_mismatch','support_attachment_invalid',
    'support_attachment_message_author_mismatch','support_attachment_message_limit',
    'support_attachment_name_invalid','support_attachment_not_uploaded',
    'support_attachment_size_invalid','support_attachment_size_mismatch',
    'support_attachment_storage_cleanup_required',
    'support_attachment_storage_metadata_invalid','support_attachment_ticket_closed',
    'support_attachment_total_size_limit','support_attachment_type_invalid',
    'support_attachment_type_mismatch','support_attachment_upload_expired',
    'support_attachment_upload_window_expired','support_client_request_id_invalid',
    SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,
    'support_close_note_invalid','support_cursor_invalid','support_description_invalid',
    'support_diagnostics_invalid','support_diagnostics_too_large',
    'support_expected_version_invalid','support_filters_invalid',
    'support_idempotency_conflict','support_impact_invalid','support_message_invalid',
    'support_module_invalid','support_payload_invalid','support_platform_action_invalid',
    'support_priority_invalid','support_reopen_reason_required',
    'support_rate_limit_exceeded','support_read_watermark_invalid',
    'support_resolution_invalid','support_resolution_required','support_scope_invalid',
    'support_status_invalid','support_tenant_action_invalid',
    'support_ticket_close_requires_resolution','support_ticket_conflict',
    'support_ticket_invalid','support_ticket_reopen_not_allowed',
    'support_ticket_requires_reopen','support_title_invalid','support_update_empty'
  ];
  return known.find(item=>source===item||source.includes(item))||null;
}

function statusFor(code,fallback){
  if(code==='authentication_required')return 401;
  if(code==='forbidden'||code==='assignee_not_allowed'
     ||code==='support_attachment_message_author_mismatch')return 403;
  if(code.endsWith('_not_found')||code==='tenant_not_found')return 404;
  if(code==='support_reopen_window_expired'
     ||code==='support_attachment_upload_expired'
     ||code==='support_attachment_upload_window_expired')return 410;
  if(code==='support_conflict'||code==='duplicate_support_request'
     ||code==='support_ticket_conflict'||code==='support_idempotency_conflict'
     ||code==='support_ticket_requires_reopen'
     ||code==='support_ticket_close_requires_resolution'
     ||code==='support_ticket_reopen_not_allowed'
     ||code==='support_attachment_ticket_closed'
     ||code==='support_attachment_count_limit'
     ||code==='support_attachment_message_limit'
     ||code==='support_attachment_total_size_limit'
     ||code==='support_attachment_storage_cleanup_required')return 409;
  if(code==='request_too_large'||code==='support_diagnostics_too_large')return 413;
  if(code==='support_rate_limit_exceeded')return 429;
  if(code===SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE)return 503;
  if(fallback>=500)return 502;
  return 400;
}

export function storageObjectPath(value){
  const segments=String(value||'').split('/');
  if(!segments.length||segments.some(segment=>!segment||segment==='.'||segment==='..')){
    throw new SupportHttpError('invalid_attachment_path',404);
  }
  const normalized=segments.map(encodeURIComponent).join('/');
  if(normalized.length>1200)throw new SupportHttpError('invalid_attachment_path',404);
  return normalized;
}

export function storageUrl(type,bucket,objectPath){
  if(!/^[a-z0-9][a-z0-9_-]{1,80}$/.test(String(bucket||''))){
    throw new SupportHttpError('invalid_attachment_path',404);
  }
  return `${SUPABASE_URL}/storage/v1/object/${type}/${encodeURIComponent(bucket)}/${storageObjectPath(objectPath)}`;
}

export function translate(code){
  return ({
    authentication_required:'انتهت الجلسة؛ سجّل الدخول ثم حاول مرة أخرى.',
    forbidden:'ليست لديك صلاحية لتنفيذ هذا الإجراء.',
    invalid_slug:'مسار المنشأة غير صالح.',
    invalid_ticket_id:'رقم التذكرة غير صالح.',
    invalid_json:'تعذر قراءة البيانات المرسلة.',
    unsupported_media_type:'نوع محتوى الطلب غير مدعوم.',
    invalid_payload:'بيانات العملية غير صالحة.',
    invalid_value:'إحدى القيم المختارة غير صالحة.',
    invalid_number:'إحدى القيم الرقمية غير صالحة.',
    invalid_timestamp:'وقت القراءة غير صالح.',
    required_field_missing:'أكمل الحقول المطلوبة.',
    field_too_long:'أحد الحقول أطول من الحد المسموح.',
    request_too_large:'حجم الطلب أكبر من الحد المسموح.',
    tenant_not_found:'المنشأة غير موجودة.',
    support_ticket_not_found:'التذكرة غير موجودة أو ليست ضمن صلاحيتك.',
    support_message_not_found:'الرسالة غير موجودة.',
    support_attachment_not_found:'المرفق غير موجود أو ليست لديك صلاحية لفتحه.',
    support_conflict:'تغيّرت التذكرة من جلسة أخرى؛ حدّث الصفحة ثم أعد المحاولة.',
    support_ticket_closed:'التذكرة مغلقة. افتح تذكرة جديدة إذا ظهرت مشكلة أخرى.',
    support_reopen_window_expired:'انتهت مدة إعادة فتح التذكرة؛ افتح تذكرة جديدة مرتبطة بها.',
    invalid_support_action:'إجراء الدعم غير مدعوم.',
    invalid_support_status:'حالة التذكرة غير صالحة.',
    invalid_support_transition:'لا يمكن نقل التذكرة مباشرة إلى هذه الحالة.',
    invalid_support_priority:'أولوية التذكرة غير صالحة.',
    invalid_support_impact:'مدى التأثير غير صالح.',
    invalid_support_module:'القسم المتأثر غير صالح.',
    invalid_attachment:'نوع المرفق أو حجمه غير مسموح.',
    invalid_attachment_path:'مسار المرفق غير صالح.',
    attachment_not_ready:'المرفق لم يكتمل رفعه بعد.',
    attachment_upload_expired:'انتهت مهلة رفع المرفق؛ اختره من جديد.',
    assignee_not_found:'موظف الدعم المحدد غير موجود.',
    assignee_not_allowed:'لا يمكن إسناد التذكرة لهذا الحساب.',
    title_required:'اكتب عنوانًا واضحًا للمشكلة.',
    description_required:'اكتب تفاصيل المشكلة.',
    message_required:'اكتب الرد قبل الإرسال.',
    duplicate_support_request:'تم تسجيل هذه التذكرة بالفعل.',
    support_queue_invalid:'قائمة المتابعة المختارة غير صالحة.',
    support_assignee_invalid:'موظف الدعم المحدد غير صالح للإسناد.',
    support_attachment_count_limit:'وصلت التذكرة إلى الحد الأقصى لعدد المرفقات.',
    support_attachment_message_limit:'وصلت الرسالة إلى الحد الأقصى لعدد المرفقات.',
    support_attachment_total_size_limit:'وصلت التذكرة إلى الحد الأقصى لإجمالي حجم المرفقات.',
    support_attachment_extension_mismatch:'امتداد الملف لا يطابق نوعه.',
    support_attachment_type_invalid:'نوع الملف غير مسموح.',
    support_attachment_type_mismatch:'نوع الملف المرفوع لا يطابق النوع المسجل.',
    support_attachment_size_invalid:'حجم الملف غير صالح.',
    support_attachment_size_mismatch:'حجم الملف المرفوع لا يطابق الحجم المسجل.',
    support_attachment_name_invalid:'اسم المرفق غير صالح.',
    support_attachment_invalid:'بيانات المرفق غير صالحة.',
    support_attachment_not_uploaded:'لم يصل الملف إلى التخزين؛ اختره وأعد المحاولة.',
    support_attachment_storage_metadata_invalid:'تعذر التحقق من بيانات الملف في التخزين.',
    support_attachment_upload_expired:'انتهت مهلة رفع المرفق؛ اختره من جديد.',
    support_attachment_upload_window_expired:'انتهت مهلة ربط المرفق بالرسالة؛ أرسل رسالة جديدة.',
    support_attachment_ticket_closed:'لا يمكن إضافة مرفق إلى تذكرة منتهية.',
    support_attachment_message_author_mismatch:'لا يمكنك إضافة مرفق إلى رسالة كتبها مستخدم آخر.',
    support_attachment_storage_cleanup_required:'يجب حذف الملف من التخزين قبل حذف سجله.',
    [SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE]:SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE,
    support_client_request_id_invalid:'معرّف المحاولة غير صالح؛ حدّث الصفحة وأعد المحاولة.',
    support_cursor_invalid:'رابط صفحة التذاكر غير صالح؛ ارجع إلى الصفحة الأولى.',
    support_filters_invalid:'فلاتر التذاكر غير صالحة.',
    support_scope_invalid:'نطاق التذاكر غير صالح.',
    support_payload_invalid:'بيانات عملية الدعم غير صالحة.',
    support_tenant_action_invalid:'إجراء المنشأة على التذكرة غير مدعوم.',
    support_platform_action_invalid:'إجراء فريق الدعم غير مدعوم.',
    support_expected_version_invalid:'نسخة التذكرة غير صالحة؛ حدّث الصفحة.',
    support_ticket_invalid:'رقم التذكرة غير صالح.',
    support_ticket_conflict:'تغيّرت التذكرة من جلسة أخرى؛ حدّث الصفحة ثم أعد المحاولة.',
    support_idempotency_conflict:'تم استخدام معرّف المحاولة لبيانات مختلفة؛ حدّث الصفحة.',
    support_ticket_requires_reopen:'أعد فتح التذكرة قبل إضافة رد أو تغيير حالتها.',
    support_ticket_close_requires_resolution:'لا يمكن إغلاق التذكرة قبل تسجيل الحل.',
    support_ticket_reopen_not_allowed:'لا يمكن إعادة فتح التذكرة من حالتها الحالية.',
    support_reopen_reason_required:'اكتب سبب إعادة فتح التذكرة.',
    support_rate_limit_exceeded:'تم إرسال محاولات كثيرة خلال وقت قصير؛ انتظر دقيقة ثم حاول مرة أخرى.',
    support_read_watermark_invalid:'وقت القراءة غير صالح؛ حدّث الصفحة ثم حاول مرة أخرى.',
    support_resolution_required:'اكتب ملخص الحل قبل إنهاء التذكرة.',
    support_resolution_invalid:'ملخص الحل غير صالح.',
    support_close_note_invalid:'ملاحظة الإغلاق غير صالحة.',
    support_update_empty:'لم ترسل أي تغيير لحفظه.',
    support_title_invalid:'عنوان التذكرة غير صالح.',
    support_description_invalid:'وصف التذكرة غير صالح.',
    support_message_invalid:'نص الرسالة غير صالح.',
    support_priority_invalid:'أولوية التذكرة غير صالحة.',
    support_impact_invalid:'مدى التأثير غير صالح.',
    support_module_invalid:'قسم أودير المتأثر غير صالح.',
    support_status_invalid:'حالة التذكرة غير صالحة.',
    support_diagnostics_invalid:'بيانات التشخيص غير صالحة.',
    support_diagnostics_too_large:'بيانات التشخيص أكبر من الحد المسموح.',
    unsupported_file_type:'نوع الملف غير مسموح. استخدم صورة أو PDF أو TXT.',
    attachment_too_large:'حجم المرفق يتجاوز 10MB.',
    attachment_name_invalid:'اسم المرفق غير صالح.',
    support_upstream_timeout:'تأخر اتصال خدمة الدعم؛ حاول مرة أخرى بعد لحظات.',
    support_upstream_unavailable:'خدمة الدعم غير متاحة مؤقتًا؛ حاول مرة أخرى بعد لحظات.',
    support_request_failed:'تعذر تنفيذ العملية الآن. حاول مرة أخرى.'
  })[code]||'تعذر تنفيذ العملية الآن. حاول مرة أخرى.';
}