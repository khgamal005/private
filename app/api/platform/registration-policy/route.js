import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {
  failClosedRegistrationEmailReadiness,
  registrationEmailActivationGrant,
  withEmailReadiness
} from '../../../../lib/platform-registration-policy';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MODES=new Set(['manual_review','email_verified_trial']);
const MAX_BODY_BYTES=2*1024;

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return error('انتهت جلسة الدخول','authentication_required',401);
    const origin=request.headers.get('origin');
    if(origin&&origin!==request.nextUrl.origin){
      return error('تعذر التحقق من مصدر الطلب','invalid_origin',403);
    }
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES){
      return error('حجم الطلب أكبر من المسموح','request_too_large',413);
    }
    const rawBody=await boundedRequestText(request,MAX_BODY_BYTES);
    if(rawBody===null){
      return error('حجم الطلب أكبر من المسموح','request_too_large',413);
    }
    let body;
    try{body=JSON.parse(rawBody);}catch{body=null;}
    if(!body||Array.isArray(body)||typeof body!=='object'){
      return error('بيانات الإعداد غير صالحة','invalid_json',400);
    }
    const activationMode=String(body.activationMode||'').trim();
    const ttl=Number(body.emailConfirmationTtlMinutes);
    const planKey=String(body.trialPlanKey||'free').trim().toLowerCase();
    if(!MODES.has(activationMode)){
      return error('وضع التفعيل غير صالح','registration_activation_mode_invalid',400);
    }
    if(!Number.isInteger(ttl)||ttl<15||ttl>1440){
      return error('مدة رابط التأكيد غير صالحة','registration_confirmation_ttl_invalid',400);
    }
    if(!/^[a-z0-9_]+$/.test(planKey)){
      return error('مفتاح الباقة غير صالح','invalid_plan_key',400);
    }
    let result;
    let emailReadiness;
    if(activationMode==='manual_review'){
      // The emergency kill switch is database-only and never waits on Edge or
      // the email provider.
      result=await rpc(token,'v1_platform_registration_policy_save',{
        p_activation_mode:activationMode,
        p_email_confirmation_ttl_minutes:ttl,
        p_trial_plan_key:planKey
      });
      emailReadiness=failClosedRegistrationEmailReadiness();
    }else{
      // Authorize with the caller's JWT before the server acts as a privileged
      // deputy and asks Edge to mint a one-time activation grant.
      await rpc(token,'v1_platform_registration_policy_snapshot',{});
      const issued=await registrationEmailActivationGrant();
      emailReadiness=issued.readiness;
      if(!emailReadiness.activationReady){
        return error(
          'أكمل إعداد الإرسال وWebhook واختبار التسليم الإنتاجي قبل تفعيل هذا الخيار',
          'registration_email_not_ready',
          409
        );
      }
      result=await rpc(token,'v1_platform_registration_policy_save_email',{
        p_email_confirmation_ttl_minutes:ttl,
        p_trial_plan_key:planKey,
        p_activation_grant:issued.activationGrant
      });
    }
    return NextResponse.json({
      success:true,
      data:withEmailReadiness(result,emailReadiness)
    });
  }catch(reason){
    const source=reason instanceof Error?reason.message:String(reason||'');
    const code=sourceCode(source);
    return error(translate(code),code,errorStatus(code));
  }
}

async function boundedRequestText(request,maxBytes){
  if(!request.body)return '';
  const reader=request.body.getReader();
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

function errorStatus(code){
  if(code==='forbidden')return 403;
  if([
    'registration_email_activation_grant_unavailable','request_failed'
  ].includes(code))return 503;
  if(code.startsWith('registration_email_activation_'))return 409;
  return 400;
}

async function rpc(token,name,payload){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(payload),
    cache:'no-store',
    signal:AbortSignal.timeout(10_000)
  });
  const text=await response.text();
  let value={};
  try{value=text?JSON.parse(text):{};}catch{value={detail:text};}
  if(!response.ok){
    throw new Error(String(value?.message||value?.detail||'request_failed'));
  }
  return value;
}

function sourceCode(source){
  return [
    'forbidden','plan_not_found','registration_activation_mode_invalid',
    'registration_confirmation_ttl_invalid',
    'registration_email_activation_not_ready',
    'registration_email_activation_grant_required',
    'registration_email_activation_grant_invalid',
    'registration_email_activation_grant_stale',
    'registration_email_activation_grant_unavailable'
  ].find(code=>source.includes(code))||'request_failed';
}

function translate(code){
  return ({
    forbidden:'ليس لديك صلاحية تعديل إعدادات التسجيل',
    plan_not_found:'الباقة المحددة غير موجودة أو غير مفعلة',
    registration_activation_mode_invalid:'وضع التفعيل غير صالح',
    registration_confirmation_ttl_invalid:'مدة رابط التأكيد غير صالحة',
    registration_email_activation_not_ready:'إعداد البريد غير جاهز للتفعيل',
    registration_email_activation_grant_required:'يلزم تحقق جديد من جاهزية البريد',
    registration_email_activation_grant_invalid:'انتهت صلاحية تحقق البريد؛ أعد المحاولة',
    registration_email_activation_grant_stale:'تغيرت السياسة أثناء الحفظ؛ راجع الحالة الحالية',
    registration_email_activation_grant_unavailable:'تعذر إصدار تحقق تفعيل البريد الآن'
  })[code]||'تعذر حفظ إعداد التسجيل الآن';
}

function error(message,code,status){
  return NextResponse.json({success:false,error:message,code},{status});
}
