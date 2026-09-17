import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const dynamic='force-dynamic';

async function post(url,body,accessToken){
  const response=await fetch(url,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      ...(accessToken?{Authorization:`Bearer ${accessToken}`}:{ }),
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store'
  });
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={detail:text}}
  return {response,data};
}

export async function POST(request){
  try{
    const {token,password}=await request.json();
    if(!token||String(token).length<32){
      return json({error:'رابط الدعوة غير صالح'},{status:400});
    }
    if(!password||String(password).length<10){
      return json({error:'كلمة المرور يجب ألا تقل عن 10 أحرف'},{status:400});
    }

    const activated=await post(
      `${SUPABASE_URL}/functions/v1/tenant-invitation-activation`,
      {token:String(token).trim(),password}
    );
    if(!activated.response.ok){
      return json({
        error:invitationError(activated.data),
        accountExists:activated.data?.error==='account_already_exists'
      },{status:activated.response.status});
    }

    const response=json({
      success:true,
      next:`/tenant/${activated.data.invitation.tenantSlug}`
    });
    setSessionCookies(response,activated.data.session);
    return response;
  }catch(error){
    console.error('[tenant-invitation-activation-unexpected]',{
      name:error instanceof Error?error.name:'Error',
      message:error instanceof Error?error.message:String(error)
    });
    return json({
      error:'تعذر تفعيل الحساب الآن'
    },{status:500});
  }
}

function json(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','private, no-store, no-cache, max-age=0, must-revalidate');
  response.headers.set('CDN-Cache-Control','no-store');
  response.headers.set('Pragma','no-cache');
  return response;
}

function setSessionCookies(response,session){
  const secure=process.env.NODE_ENV==='production';
  response.cookies.set(ACCESS_COOKIE,session.access_token,{
    httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:session.expires_in||3600
  });
  response.cookies.set(REFRESH_COOKIE,session.refresh_token,{
    httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:60*60*24*30
  });
}

function invitationError(data){
  const code=String(data?.error||data?.message||data?.detail||'');
  const messages={
    plan_limit_reached:'وصلت المنشأة إلى الحد الأقصى لحسابات الموظفين في باقتها. اطلب من مدير المنشأة زيادة السعة أو إيقاف حساب غير مستخدم ثم أعد المحاولة بنفس الدعوة.',
    sign_in_failed:'تم إنشاء الحساب وتعذر الدخول؛ أعد المحاولة بكلمة المرور نفسها أو استخدم تسجيل الدخول.',
    invalid_invitation:'رابط الدعوة غير صالح أو تم استخدامه من قبل',
    invitation_expired:'انتهت صلاحية رابط الدعوة؛ اطلب دعوة جديدة',
    invitation_email_mismatch:'الدعوة مرتبطة ببريد مختلف',
    account_not_available:'تعذر ربط حساب المستخدم بالدعوة',
    weak_password:'كلمة المرور يجب ألا تقل عن 10 أحرف',
    account_already_exists:'هذا البريد لديه حساب مؤكد بالفعل؛ استخدم تسجيل الدخول وقبول الدعوة.',
    server_not_configured:'تفعيل حسابات الموظفين غير متاح مؤقتًا',
    activation_failed:'تعذر إنشاء حساب الموظف الآن'
  };
  return messages[code]||'تعذر التحقق من الدعوة';
}

