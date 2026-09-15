import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from './config';
import {isTrustedSupportRequestOrigin} from './support-request-origin.mjs';

export async function readServiceBody(request){
  if(!isTrustedSupportRequestOrigin(request))throw Object.assign(Error('تعذر التحقق من مصدر الطلب.'),{status:403});
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw Object.assign(Error('نوع الطلب غير مدعوم.'),{status:415});
  const reader=request.body?.getReader();let length=0;const chunks=[];
  if(!reader)throw Object.assign(Error('الطلب فارغ.'),{status:400});
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>24576){await reader.cancel();throw Object.assign(Error('بيانات الطلب أطول من المسموح.'),{status:413});}chunks.push(value);}}
  finally{reader.releaseLock();}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(Error('بيانات الطلب غير صالحة.'),{status:400});}
}
export const serviceJson=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function serviceRpc(name,body,{publicAccess=false}={}){
  const token=publicAccess?null:(await cookies()).get(ACCESS_COOKIE)?.value;
  if(!publicAccess&&!token)throw Object.assign(Error('انتهت الجلسة.'),{status:401});
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:SUPABASE_KEY,...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok){const code=String(data?.message||'');const messages={forbidden:'ليست لديك صلاحية لهذا الإجراء.',service_request_conflict:'تغير الطلب؛ حدّث الصفحة وراجع أحدث نسخة.',service_offer_expired:'انتهت صلاحية العرض. اطلب من الإدارة تجديده.',service_request_invalid:'راجع تفاصيل الطلب والحقول المطلوبة.',service_request_not_found:'الطلب غير موجود.',service_application_rate_limited:'تم استقبال عدة طلبات مؤخرًا. حاول لاحقًا.',service_application_invalid:'راجع بيانات طلب الانضمام.',service_provider_not_ready:'أكمل الاسم والنبذة والتخصص واجعل المحاضر نشطًا أولًا.',service_application_duplicate_provider:'يوجد ملف بهذا البريد. اختر ربط الطلب بملف المحاضر الموجود.',service_quote_payment_locked:'وسيلة الدفع والسعر مرتبطان بالعرض المعتمد. راجع الإدارة لإصدار عرض جديد عند الحاجة.',marketplace_payment_provider_unavailable:'وسيلة الدفع غير متاحة الآن. اختر وسيلة أخرى.',service_hub_not_enabled:'هذه الميزة قيد التجهيز وستتاح قريبًا.'};throw Object.assign(Error(messages[code]||'تعذر إتمام العملية. حدّث الصفحة وأعد المحاولة.'),{status:code==='forbidden'?403:code.includes('rate_limited')?429:409});}
  return data;
}
export const serviceFailure=error=>serviceJson({error:error.status?error.message:'تعذر الاتصال الآن. حاول مرة أخرى.'},error.status||503);
