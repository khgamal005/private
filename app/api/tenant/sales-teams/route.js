import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await request.json();
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_assign_sales_team_member`,
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
          p_supervisor_staff_id:body.supervisorStaffId||null
        }),
        cache:'no-store'
      }
    );
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      return NextResponse.json({error:translate(data?.message||data?.detail)},{status:response.status});
    }
    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({error:'تعذر تحديث فريق المبيعات',detail:error.message},{status:500});
  }
}

function translate(value){
  return ({
    forbidden:'ليس لديك صلاحية لتوزيع فرق المبيعات',
    tenant_not_found:'المنشأة غير موجودة',
    staff_not_found:'مسؤول المبيعات غير موجود',
    invalid_sales_team_member:'يمكن إسناد مسؤولي المبيعات فقط',
    invalid_sales_supervisor:'المشرف المختار غير صالح أو لا يتبع المنشأة'
  })[value]||'تعذر حفظ إسناد الفريق';
}
