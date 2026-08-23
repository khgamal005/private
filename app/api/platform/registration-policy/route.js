import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {registrationEmailReady} from '../../../../lib/platform-registration-policy';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MODES=new Set(['manual_review','email_verified_trial']);

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return error('انتهت جلسة الدخول','authentication_required',401);
    const body=await request.json().catch(()=>null);
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
    const emailReady=await registrationEmailReady();
    if(activationMode==='email_verified_trial'&&!emailReady){
      return error(
        'أكمل إعداد بريد أودير المرسل والدومين قبل تفعيل هذا الخيار',
        'registration_email_not_ready',
        409
      );
    }
    const result=await rpc(token,'v1_platform_registration_policy_save',{
      p_activation_mode:activationMode,
      p_email_confirmation_ttl_minutes:ttl,
      p_trial_plan_key:planKey
    });
    return NextResponse.json({success:true,data:{
      ...result,
      emailReady
    }});
  }catch(reason){
    const source=reason instanceof Error?reason.message:String(reason||'');
    const code=sourceCode(source);
    return error(translate(code),code,code==='forbidden'?403:400);
  }
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
    'registration_confirmation_ttl_invalid'
  ].find(code=>source.includes(code))||'request_failed';
}

function translate(code){
  return ({
    forbidden:'ليس لديك صلاحية تعديل إعدادات التسجيل',
    plan_not_found:'الباقة المحددة غير موجودة أو غير مفعلة',
    registration_activation_mode_invalid:'وضع التفعيل غير صالح',
    registration_confirmation_ttl_invalid:'مدة رابط التأكيد غير صالحة'
  })[code]||'تعذر حفظ إعداد التسجيل الآن';
}

function error(message,code,status){
  return NextResponse.json({success:false,error:message,code},{status});
}
