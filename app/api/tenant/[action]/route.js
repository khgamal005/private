import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const RPC={
  'create-staff':'v2_tenant_create_staff',
  'update-staff':'v2_tenant_update_staff',
  'invite-staff':'v2_tenant_invite_staff',
  'create-course':'v2_tenant_create_course'
};

export async function POST(request,{params}){
  try{
    const {action}=await params;
    const rpc=RPC[action];
    if(!rpc){
      return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    }

    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(await request.json()),
      cache:'no-store'
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      return NextResponse.json({
        error:translate(data?.message||data?.detail||'تعذر تنفيذ العملية'),
        detail:data
      },{status:response.status});
    }

    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({
      error:'تعذر تنفيذ العملية',
      detail:error.message
    },{status:500});
  }
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لتنفيذ العملية',
    tenant_not_found:'المنشأة غير موجودة',
    full_name_required:'اسم الموظف مطلوب',
    invalid_role:'الدور المختار غير صالح',
    invalid_email:'البريد الإلكتروني غير صالح',
    staff_exists:'الموظف مسجل بالفعل بنفس الدور',
    staff_not_found:'ملف الموظف غير موجود',
    staff_email_exists:'البريد مستخدم في ملف موظف آخر',
    staff_account_already_active:'حساب الموظف نشط بالفعل',
    active_account_email_locked:'لا يمكن تغيير بريد حساب نشط من الملف الوظيفي',
    cannot_remove_own_admin_access:'لا يمكنك إزالة صلاحيتك الإدارية من حسابك الحالي',
    invalid_employment_status:'الحالة الوظيفية غير صالحة',
    invalid_capacity:'الطاقة الأسبوعية خارج النطاق المسموح',
    course_title_required:'اسم الدورة مطلوب',
    course_code_required:'كود الدورة مطلوب',
    course_exists:'توجد دورة مسجلة بهذا الكود',
    invalid_delivery_mode:'طريقة تقديم الدورة غير صالحة'
  };
  return messages[String(value)]||String(value);
}
