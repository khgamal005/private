import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token){
      return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    }

    const body=await request.json().catch(()=>({}));
    const action=String(body.action||'').trim();
    if(!action){
      return NextResponse.json({error:'الإجراء غير محدد'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_platform_access_action`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_action:action,
          p_payload:body.payload&&typeof body.payload==='object'
            ?body.payload
            :{}
        }),
        cache:'no-store'
      }
    );

    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{};}catch{data={detail:text};}

    if(!response.ok){
      const source=String(
        data?.message||data?.error||data?.detail||'platform_access_failed'
      );
      return NextResponse.json({
        error:translate(source),
        code:source.split(':')[0]
      },{status:response.status});
    }

    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({
      error:'تعذر تنفيذ عملية إدارة فريق المنصة الآن',
      detail:error instanceof Error?error.message:String(error)
    },{status:500});
  }
}

function translate(value){
  const code=String(value||'').split(':')[0].trim();
  const messages={
    authentication_required:'يجب تسجيل الدخول أولًا',
    forbidden:'ليس لديك صلاحية إدارة فريق المنصة',
    invalid_role_name:'اسم الدور يجب أن يتكون من حرفين على الأقل',
    invalid_permissions:'قائمة الصلاحيات غير صالحة',
    role_name_exists:'يوجد دور آخر بنفس الاسم',
    role_not_found:'الدور المحدد غير موجود',
    system_role_protected:'لا يمكن حذف دور أساسي تابع للنظام',
    role_in_use:'لا يمكن حذف الدور لأنه مرتبط بموظف أو دعوة معلقة',
    cannot_remove_own_access:'لا يمكنك إزالة آخر صلاحية تسمح لك بإدارة فريق المنصة من حسابك الحالي',
    full_name_required:'اسم الموظف مطلوب',
    invalid_email:'البريد الإلكتروني غير صالح',
    invalid_role:'الدور المختار غير صالح',
    owner_assignment_forbidden:'تعيين أو تعديل دور مالك المنصة متاح لمالك المنصة فقط',
    employee_exists:'هذا البريد مرتبط بالفعل بموظف نشط في المنصة',
    employee_not_found:'موظف المنصة غير موجود',
    cannot_change_own_status:'لا يمكنك إيقاف حسابك الحالي',
    cannot_suspend_last_access_manager:'لا يمكن إيقاف آخر مستخدم يملك صلاحية إدارة فريق المنصة',
    invitation_not_found:'الدعوة غير موجودة أو لم تعد نشطة',
    invalid_platform_access_action:'الإجراء المطلوب غير مدعوم'
  };
  return messages[code]||'تعذر حفظ إعدادات فريق المنصة والصلاحيات';
}
