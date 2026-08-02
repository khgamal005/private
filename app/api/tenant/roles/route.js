import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const body=await request.json().catch(()=>({}));
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_role_management_action`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_slug:body.tenantSlug,
          p_action:body.action,
          p_payload:body.payload||{}
        }),
        cache:'no-store'
      }
    );

    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      return NextResponse.json({
        error:translate(
          data?.message
          ||data?.error
          ||data?.detail
          ||'تعذر حفظ إعدادات الدور'
        )
      },{status:response.status});
    }

    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({
      error:'تعذر حفظ إعدادات الدور',
      detail:error instanceof Error?error.message:String(error)
    },{status:500});
  }
}

function translate(value){
  const raw=String(value||'').split(':')[0];
  return ({
    forbidden:'ليس لديك صلاحية لإدارة الأدوار والصلاحيات',
    tenant_not_found:'المنشأة غير موجودة',
    invalid_role_name:'اسم الدور يجب أن يتكون من حرفين على الأقل',
    role_name_exists:'يوجد دور آخر بنفس الاسم داخل المنشأة',
    invalid_permissions:'قائمة الصلاحيات المرسلة غير صالحة',
    role_not_found:'الدور المحدد غير موجود',
    role_not_customized:'هذا الدور يستخدم إعدادات ماركتون الافتراضية بالفعل',
    role_in_use:'لا يمكن حذف الدور لأنه مرتبط بموظف أو مستخدم أو دعوة معلقة',
    system_role_use_reset:'استخدم «استعادة الافتراضي» بدل حذف الدور الأساسي',
    cannot_remove_own_role_management:'لا يمكنك إزالة آخر صلاحية تسمح لك بإدارة الأدوار من حسابك الحالي',
    invalid_role_action:'عملية إدارة الدور غير مدعومة'
  })[raw]||'تعذر حفظ إعدادات الدور';
}
