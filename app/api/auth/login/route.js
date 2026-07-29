import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export async function POST(request){
  try{
    const {email,password,invitationToken}=await request.json();
    if(!email||!password){
      return NextResponse.json({error:'أدخل البريد وكلمة المرور'},{status:400});
    }

    const authResponse=await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method:'POST',
        headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
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
      return NextResponse.json({
        error:authCode==='email_not_confirmed'
          ?'الحساب لم يكتمل تفعيله؛ افتح رابط الدعوة وأنشئ كلمة المرور مرة أخرى.'
          :'بيانات الدخول غير صحيحة',
        detail:session?.msg||session?.message
      },{status:401});
    }

    let acceptedInvitation=null;
    if(invitationToken){
      const invitationResponse=await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/v2_accept_tenant_invitation`,
        {
          method:'POST',
          headers:{
            apikey:SUPABASE_KEY,
            Authorization:`Bearer ${session.access_token}`,
            'Content-Type':'application/json'
          },
          body:JSON.stringify({p_token:String(invitationToken).trim()}),
          cache:'no-store'
        }
      );
      const invitationData=await invitationResponse.json();
      if(!invitationResponse.ok){
        return NextResponse.json({
          error:invitationError(invitationData)
        },{status:400});
      }
      acceptedInvitation=invitationData;
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
      return NextResponse.json({
        error:'الحساب غير مربوط بمنصة ماركتون'
      },{status:403});
    }

    const next=acceptedInvitation?.tenantSlug
      ?`/tenant/${acceptedInvitation.tenantSlug}`
      :context.subject?.mustChangePassword
        ?'/change-password'
        :context.platformAccess
          ?'/control'
          :context.memberships?.[0]?.tenantSlug
            ?`/tenant/${context.memberships[0].tenantSlug}`
            :'/';
    const response=NextResponse.json({success:true,context,next});
    const secure=process.env.NODE_ENV==='production';
    response.cookies.set(ACCESS_COOKIE,session.access_token,{
      httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:session.expires_in||3600
    });
    response.cookies.set(REFRESH_COOKIE,session.refresh_token,{
      httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:60*60*24*30
    });
    return response;
  }catch(error){
    return NextResponse.json({
      error:'تعذر تسجيل الدخول',
      detail:error.message
    },{status:500});
  }
}

function invitationError(data){
  const code=String(data?.message||data?.detail||'');
  const messages={
    invalid_invitation:'رابط الدعوة غير صالح أو تم استخدامه من قبل',
    invitation_expired:'انتهت صلاحية رابط الدعوة؛ اطلب دعوة جديدة',
    invitation_email_mismatch:'سجّلت الدخول ببريد مختلف عن البريد المدعو'
  };
  return messages[code]||'تعذر قبول دعوة المنشأة';
}
