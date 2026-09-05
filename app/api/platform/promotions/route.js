import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {publicAppOrigin} from '../../../../lib/public-app-origin';

const MAX_REQUEST_BYTES=48*1024;
const MAX_UPSTREAM_BYTES=128*1024;
const RPC_TIMEOUT_MS=15_000;
const ACTIONS=new Set(['save_promotion','set_status','delete_draft']);
const BODY_KEYS=new Set(['action','payload']);

export async function POST(request){
  try{
    if(!sameOrigin(request))return json({error:'تعذر التحقق من مصدر الطلب'},{status:403});
    const contentType=String(request.headers.get('content-type')||'')
      .split(';',1)[0].trim().toLowerCase();
    if(contentType!=='application/json')return json({error:'نوع بيانات الطلب غير مدعوم'},{status:415});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});
    const inbound=await readTextLimited(request,MAX_REQUEST_BYTES);
    if(inbound.tooLarge)return json({error:'بيانات العرض أكبر من الحد المسموح'},{status:413});
    let body;
    try{body=JSON.parse(inbound.text)}catch{return json({error:'بيانات العرض غير صالحة'},{status:400});}
    if(!body||typeof body!=='object'||Array.isArray(body)
       ||Object.keys(body).some(key=>!BODY_KEYS.has(key))
       ||!ACTIONS.has(body.action)
       ||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)){
      return json({error:'بيانات العرض غير صالحة'},{status:400});
    }
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v1_platform_marketplace_promotion_action`,{
        method:'POST',redirect:'error',cache:'no-store',
        headers:{
          apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,
          'Content-Type':'application/json',Accept:'application/json'
        },
        body:JSON.stringify({p_action:body.action,p_payload:body.payload}),
        signal:AbortSignal.timeout(RPC_TIMEOUT_MS)
      }
    );
    const upstream=await readTextLimited(response,MAX_UPSTREAM_BYTES);
    if(upstream.tooLarge)return json({error:'تعذر التحقق من نتيجة العملية'},{status:502});
    let data;
    try{data=JSON.parse(upstream.text)}catch{return json({error:'تعذر التحقق من نتيجة العملية'},{status:502});}
    if(!response.ok){
      const errorCode=safeErrorCode(data?.message||data?.error);
      return json({error:translate(errorCode),errorCode},{status:safeStatus(response.status)});
    }
    return json({success:true,data});
  }catch(error){
    const timedOut=error instanceof Error&&error.name==='TimeoutError';
    return json({error:timedOut?'تأخر تنفيذ العملية؛ حدّث القائمة قبل إعادة المحاولة':'تعذر تنفيذ عملية البرومو'},{status:timedOut?504:503});
  }
}

async function readTextLimited(source,maxBytes){
  const length=source.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>maxBytes){
    await source.body?.cancel('body_too_large').catch(()=>{});
    return {tooLarge:true,text:''};
  }
  if(!source.body)return {tooLarge:false,text:''};
  const reader=source.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done){text+=decoder.decode();return {tooLarge:false,text};}
      bytes+=value.byteLength;
      if(bytes>maxBytes){await reader.cancel('body_too_large').catch(()=>{});return {tooLarge:true,text:''};}
      text+=decoder.decode(value,{stream:true});
    }
  }finally{reader.releaseLock();}
}
// The browser Origin is checked against ODEIR's canonical public URL; proxy
// forwarding headers are never accepted as the CSRF authority for this action.
function sameOrigin(request){
  const site=String(request.headers.get('sec-fetch-site')||'').toLowerCase();
  if(site&&site!=='same-origin')return false;
  const origin=String(request.headers.get('origin')||'').trim();
  if(!origin)return false;
  try{
    const source=new URL(origin);
    return source.username===''&&source.password===''
      &&source.pathname==='/'&&!source.search&&!source.hash
      &&source.origin===publicAppOrigin();
  }catch{return false;}
}
function safeErrorCode(value){
  const code=String(value||'').trim();
  return /^[a-z][a-z0-9_]{0,119}$/.test(code)?code:'promotion_action_unavailable';
}
function safeStatus(status){return [400,401,403,404,409,422,429].includes(status)?status:503;}
function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لإدارة العروض',
    platform_subject_not_found:'تعذر ربط المستخدم بحساب المنصة',
    promotion_payload_invalid:'راجع بيانات البرومو والحدود والتواريخ',
    promotion_not_found:'العرض غير موجود',
    promotion_status_invalid:'حالة العرض غير صالحة',
    promotion_code_inactive:'لا يمكن تفعيل عرض انتهت صلاحيته',
    promotion_terms_locked:'بدأ استخدام العرض؛ لا يمكن تغيير شروطه المالية أو نطاقه. أنشئ رمزًا جديدًا',
    promotion_tenant_scope_invalid:'إحدى المنشآت المختارة غير صالحة لهذا العرض',
    promotion_product_scope_invalid:'أحد المنتجات المختارة غير موجود أو غير متاح',
    promotion_delete_forbidden:'لا يمكن حذف هذا العرض؛ يمكن أرشفته بدلًا من ذلك',
    promotion_action_invalid:'إجراء العرض غير مدعوم'
  };
  return messages[value]||'تعذر تنفيذ عملية البرومو';
}
function json(body,init={}){
  return NextResponse.json(body,{...init,headers:{
    'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
    'X-Content-Type-Options':'nosniff',...(init.headers||{})
  }});
}
