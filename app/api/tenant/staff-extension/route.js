import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await request.json();
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_assign_staff_extension`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_tenant_slug:body.tenantSlug,
          p_staff_id:body.staffId,
          p_extension:body.extension||null
        }),
        cache:'no-store'
      }
    );
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      return NextResponse.json({
        error:translate(data?.message||data?.detail)
      },{status:response.status});
    }
    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({
      error:'تعذر حفظ تحويلة Yeastar',
      detail:error.message
    },{status:500});
  }
}

function translate(value){
  return ({
    forbidden:'ليس لديك صلاحية لتعديل بيانات الموظفين',
    tenant_not_found:'المنشأة غير موجودة',
    staff_not_found:'الموظف غير موجود أو غير نشط',
    yeastar_addon_not_enabled:'إضافة Yeastar غير مفعّلة لهذه المنشأة',
    yeastar_connection_not_configured:'استكمل ربط Yeastar من إعدادات المنشأة أولًا',
    yeastar_invalid_extension:'رقم التحويلة يجب أن يتكون من أرقام فقط وبحد أقصى 10 أرقام',
    yeastar_extension_already_assigned:'هذه التحويلة مرتبطة بموظف آخر بالفعل'
  })[value]||'تعذر حفظ تحويلة Yeastar';
}
