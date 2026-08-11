import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';
import {
  resolvePostLoginPath
} from '../../../../lib/login-destination.mjs';

export const dynamic='force-dynamic';

export async function POST(request){
  try{
    const {
      email,
      password,
      invitationToken,
      platformInvitationToken,
      requestedNext
    }=await request.json();
    if(!email||!password){
      return json({error:'أدخل البريد وكلمة المرور'},{status:400});
    }

    const authResponse=await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          email:String(email).trim().toLowerCase(),
          password
        }),
        cache:'no-store'
      }
    );
    const session=await authResponse.json();
    if(!authResponse.ok){
      const authCode=String(session?.error_code||'');
      return json({
        error:authCode==='email_not_confirmed'
          ?'الحساب لم يكتمل تفعيله؛ افتح رابط الدعوة وأنشئ كلمة المرور مرة أخرى.'
          :'بيانات الدخول غير صحيحة',
        detail:session?.msg||session?.message
      },{status:401});
    }

    let acceptedTenantInvitation=null;
    let acceptedPlatformInvitation=null;

    if(invitationToken){
      const accepted=await acceptInvitation(
        'v2_accept_tenant_invitation',
        invitationToken,
        session.access_token
      );
      if(!accepted.ok){
        return json({
          error:invitationError(accepted.data,'tenant')
        },{status:400});
      }
      acceptedTenantInvitation=accepted.data;
    }

    if(platformInvitationToken){
      const accepted=await acceptInvitation(
        'v2_accept_platform_invitation',
        platformInvitationToken,
        session.access_token
      );
      if(!accepted.ok){
        return json({
          error:invitationError(accepted.data,'platform')
        },{status:400});
      }
      acceptedPlatformInvitation=accepted.data;
    }

    const contextResponse=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_current_user_context`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${session.access_token}`,
          'Content-Type':'application/json'
        },
        body:'{}',
        cache:'no-store'
      }
    );
    const context=await contextResponse.json();
    if(!contextResponse.ok){
      return json({
        error:'الحساب غير مربوط بمنصة ماركتون'
      },{status:403});
    }

    const next=resolvePostLoginPath({
      context,
      requestedNext,
      acceptedTenantInvitation,
      acceptedPlatformInvitation
    });

    const response=json({success:true,context,next});
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
    return response;
  }catch(error){
    return json({
      error:'تعذر تسجيل الدخول',
      detail:error instanceof Error?error.message:String(error)
    },{status:500});
  }
}

function json(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','private, no-store');
  response.headers.set('Pragma','no-cache');
  return response;
}

async function acceptInvitation(rpcName,token,accessToken){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${accessToken}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({p_token:String(token).trim()}),
    cache:'no-store'
  });
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={detail:text};}
  return {ok:response.ok,data};
}

function invitationError(data,scope){
  const code=String(data?.message||data?.error||data?.detail||'').split(':')[0];
  const messages={
    invalid_invitation:'رابط الدعوة غير صالح أو تم استخدامه من قبل',
    invitation_expired:'انتهت صلاحية رابط الدعوة؛ اطلب دعوة جديدة',
    invitation_email_mismatch:'سجّلت الدخول ببريد مختلف عن البريد المدعو',
    account_not_available:'تعذر ربط الحساب بالدعوة'
  };
  return messages[code]||(scope==='platform'
    ?'تعذر قبول دعوة فريق المنصة'
    :'تعذر قبول دعوة المنشأة');
}
