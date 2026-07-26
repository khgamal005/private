import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

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
      return NextResponse.json({error:'رابط الدعوة غير صالح'},{status:400});
    }
    if(!password||String(password).length<10){
      return NextResponse.json({error:'كلمة المرور يجب ألا تقل عن 10 أحرف'},{status:400});
    }

    const preview=await post(
      `${SUPABASE_URL}/rest/v1/rpc/v2_invitation_preview`,
      {p_token:String(token).trim()}
    );
    if(!preview.response.ok){
      return NextResponse.json({error:invitationError(preview.data)},{status:400});
    }

    const signupUrl=new URL(`${SUPABASE_URL}/auth/v1/signup`);
    signupUrl.searchParams.set(
      'redirect_to',
      `${request.nextUrl.origin}/login?invite=${encodeURIComponent(String(token).trim())}`
    );
    const signup=await post(signupUrl.toString(),{
      email:preview.data.email,
      password,
      data:{full_name:preview.data.fullName}
    });

    if(!signup.response.ok){
      const message=String(signup.data?.msg||signup.data?.message||'');
      const exists=/already|registered|exists/i.test(message);
      return NextResponse.json({
        error:exists
          ?'هذا البريد لديه حساب بالفعل؛ استخدم تسجيل الدخول لإكمال ربطه بالمنشأة.'
          :'تعذر إنشاء الحساب. تأكد من قوة كلمة المرور ثم حاول مرة أخرى.',
        accountExists:exists
      },{status:exists?409:signup.response.status});
    }

    if(!signup.data?.access_token){
      return NextResponse.json({
        success:true,
        needsEmailConfirmation:true,
        email:preview.data.email,
        message:'تم إنشاء الحساب. افتح رسالة التأكيد في بريدك ثم سجّل الدخول من رابط الدعوة.'
      });
    }

    const accepted=await post(
      `${SUPABASE_URL}/rest/v1/rpc/v2_accept_tenant_invitation`,
      {p_token:String(token).trim()},
      signup.data.access_token
    );
    if(!accepted.response.ok){
      return NextResponse.json({error:invitationError(accepted.data)},{status:400});
    }

    const response=NextResponse.json({
      success:true,
      next:`/tenant/${accepted.data.tenantSlug}`
    });
    setSessionCookies(response,signup.data);
    return response;
  }catch(error){
    return NextResponse.json({
      error:'تعذر تفعيل الحساب الآن',
      detail:error.message
    },{status:500});
  }
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
  const code=String(data?.message||data?.detail||'');
  const messages={
    invalid_invitation:'رابط الدعوة غير صالح أو تم استخدامه من قبل',
    invitation_expired:'انتهت صلاحية رابط الدعوة؛ اطلب دعوة جديدة',
    invitation_email_mismatch:'الدعوة مرتبطة ببريد مختلف',
    account_not_available:'تعذر ربط حساب المستخدم بالدعوة'
  };
  return messages[code]||'تعذر التحقق من الدعوة';
}
