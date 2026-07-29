import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const runtime='nodejs';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return json({error:'انتهت الجلسة'},{status:401});
    }
    const body=await request.json();
    const tenantSlug=String(body?.p_tenant_slug||'').trim();
    const staffId=String(body?.p_staff_id||'').trim();
    if(!tenantSlug||!isUuid(staffId)){
      return json({error:'بيانات الموظف غير مكتملة'},{status:400});
    }

    const resetResponse=await fetch(
      `${SUPABASE_URL}/functions/v1/tenant-staff-password-reset`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_tenant_slug:tenantSlug,
          p_staff_id:staffId
        }),
        cache:'no-store'
      }
    );
    const resetData=await parse(resetResponse);
    if(!resetResponse.ok){
      return json({
        error:translate(resetData),
        detail:resetData
      },{status:resetResponse.status});
    }

    return json(resetData);
  }catch(error){
    return json({
      error:'تعذر إعادة تعيين كلمة المرور',
      detail:error.message
    },{status:500});
  }
}

async function parse(response){
  const text=await response.text();
  if(!text)return null;
  try{return JSON.parse(text)}catch{return {detail:text}}
}

function json(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','no-store, max-age=0');
  return response;
}

function isUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function translate(payload){
  const code=String(
    payload?.error
    ||payload?.message
    ||payload?.detail
    ||''
  );
  const messages={
    forbidden:'ليس لديك صلاحية لإعادة تعيين كلمة المرور',
    tenant_not_found:'المنشأة غير موجودة',
    staff_account_not_active:'إعادة التعيين متاحة للحسابات النشطة فقط',
    cannot_reset_own_password:'غيّر كلمة مرور حسابك من صفحة تغيير كلمة المرور',
    protected_staff_account:'لا يمكنك إعادة تعيين كلمة مرور مدير بصلاحية مساوية أو أعلى',
    session_expired:'انتهت الجلسة؛ سجل الدخول مرة أخرى',
    auth_password_update_failed:'تعذر تحديث كلمة مرور الموظف',
    security_log_completion_failed:'تم تحديث كلمة المرور لكن تعذر إكمال سجل الأمان؛ أعد المحاولة',
    server_not_configured:'إعادة تعيين كلمة المرور غير متاحة مؤقتًا'
  };
  return messages[code]||'تعذر التحقق من صلاحية إعادة التعيين';
}
