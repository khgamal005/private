import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {
  registrationEmailReadiness,
  withEmailReadiness
} from '../../../../lib/platform-registration-policy';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {publicAppOrigin} from '../../../../lib/public-app-origin';

const EDGE_FUNCTION='odeir-registration-intake';
const MAX_BODY_BYTES=2*1024;

export async function GET(){
  try{
    const token=await accessToken();
    if(!token)return error('انتهت جلسة الدخول','authentication_required',401);
    await authorize(token);
    const readiness=await registrationEmailReadiness(token);
    return NextResponse.json({
      success:true,
      data:withEmailReadiness({},readiness)
    },{headers:{'Cache-Control':'private, no-store, max-age=0'}});
  }catch(reason){
    return routeError(reason);
  }
}

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return error('انتهت جلسة الدخول','authentication_required',401);
    const origin=request.headers.get('origin');
    if(origin!==publicAppOrigin()){
      return error('تعذر التحقق من مصدر الطلب','invalid_origin',403);
    }
    await authorize(token);

    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES){
      return error('حجم الطلب أكبر من المسموح','request_too_large',413);
    }
    const rawBody=await boundedRequestText(request,MAX_BODY_BYTES);
    if(rawBody===null){
      return error('حجم الطلب أكبر من المسموح','request_too_large',413);
    }
    let body;
    try{body=JSON.parse(rawBody);}catch{
      return error('بيانات الاختبار غير صالحة','invalid_json',400);
    }
    const recipient=String(body?.recipient||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)||recipient.length>240){
      return error('أدخل بريد اختبار صالحًا','invalid_email',400);
    }

    const readiness=await registrationEmailReadiness(token);
    if(!readiness.sendReady||!readiness.telemetryReady){
      return error(
        'أكمل إعداد المرسل وWebhook قبل إرسال اختبار الإنتاج',
        'registration_email_canary_not_ready',409
      );
    }
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'content-type':'application/json',
          Authorization:`Bearer ${token}`
        },
        body:JSON.stringify({action:'canary',recipient}),
        cache:'no-store',
        signal:AbortSignal.timeout(15_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true){
      return error(
        'تعذر إرسال اختبار الإنتاج الآن',
        String(result.error||'registration_email_canary_send_failed'),
        response.status===429?429:(response.status===409?409:503)
      );
    }
    return NextResponse.json({
      success:true,
      data:{
        state:String(result.state||'accepted'),
        providerMessageId:String(result.providerMessageId||'')
      }
    },{status:202,headers:{'Cache-Control':'private, no-store, max-age=0'}});
  }catch(reason){
    return routeError(reason);
  }
}

async function authorize(token){
  const response=await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/v1_platform_registration_policy_snapshot`,
    {
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'content-type':'application/json'
      },
      body:'{}',
      cache:'no-store',
      signal:AbortSignal.timeout(10_000)
    }
  );
  if(!response.ok){
    const detail=await response.text();
    throw new Error(detail.includes('forbidden')?'forbidden':'request_failed');
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

function routeError(reason){
  const source=reason instanceof Error?reason.message:String(reason||'');
  if(source.includes('forbidden')){
    return error('ليس لديك صلاحية تشغيل اختبار البريد','forbidden',403);
  }
  console.error('odeir_registration_email_canary_route_failed',{
    errorName:reason instanceof Error?reason.name:'UnknownError'
  });
  return error('تعذر تشغيل اختبار البريد الآن','request_failed',503);
}

function error(message,code,status){
  return NextResponse.json({success:false,error:message,code},{status});
}
