import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const dynamic='force-dynamic';

export async function POST(request){
  try{
    const {token,password}=await request.json();
    if(!token||String(token).length<32){
      return json({error:'رابط الدعوة غير صالح'},{status:400});
    }
    if(!password||String(password).length<10){
      return json({
        error:'كلمة المرور يجب ألا تقل عن 10 أحرف'
      },{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/platform-invitation-activation`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          token:String(token).trim(),
          password:String(password)
        }),
        cache:'no-store'
      }
    );
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{};}catch{data={detail:text};}

    if(!response.ok){
      return json({
        error:invitationError(data),
        accountExists:data?.error==='account_already_exists'
      },{status:response.status});
    }

    const result=json({success:true,next:'/control'});
    setSessionCookies(result,data.session);
    return result;
  }catch(error){
    console.error('[platform-invitation-activation-unexpected]',{
      name:error instanceof Error?error.name:'Error',
      message:error instanceof Error?error.message:String(error)
    });
    return json({
      error:'تعذر تفعيل حساب موظف المنصة الآن'
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
  if(!session?.access_token||!session?.refresh_token)return;
  const secure=process.env.NODE_ENV==='production';
  response.cookies.set(ACCESS_COOKIE,session.access_token,{
    httpOnly:true,
    secure,
    sameSite:'lax',
    path:'/',
    maxAge:session.expires_in||3600
  });
  response.cookies.set(REFRESH_COOKIE,session.refresh_token,{
    httpOnly:true,
    secure,
    sameSite:'lax',
    path:'/',
    maxAge:60*60*24*30
  });
}

function invitationError(data){
  const code=String(data?.error||data?.message||data?.detail||'');
  const messages={
    invalid_invitation:'رابط الدعوة غير صالح أو تم استخدامه من قبل',
    invitation_expired:'انتهت صلاحية رابط الدعوة؛ اطلب دعوة جديدة',
    invitation_email_mismatch:'الدعوة مرتبطة ببريد مختلف',
    account_not_available:'تعذر ربط حساب الموظف بالمنصة',
    weak_password:'كلمة المرور يجب ألا تقل عن 10 أحرف',
    account_already_exists:'هذا البريد لديه حساب مؤكد بالفعل؛ استخدم تسجيل الدخول وقبول الدعوة.',
    server_not_configured:'تفعيل حسابات موظفي المنصة غير متاح مؤقتًا',
    activation_failed:'تعذر إنشاء حساب موظف المنصة الآن'
  };
  return messages[code]||'تعذر التحقق من دعوة موظف المنصة';
}
