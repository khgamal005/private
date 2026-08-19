import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';
import {presentLeadAssignments} from '../../../../lib/lead-distribution-mode.mjs';

const RPC='v1_tenant_lead_assignment_search';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const body=await request.json();
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${RPC}`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store'
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      return NextResponse.json({
        error:translate(
          data?.message
          ||data?.error
          ||data?.detail
          ||'تعذر البحث في سجل التوزيع'
        ),
        detail:data
      },{status:response.status});
    }

    return NextResponse.json({
      success:true,
      data:{
        ...data,
        assignments:presentLeadAssignments(data?.assignments)
      }
    });
  }catch(error){
    return NextResponse.json({
      error:'تعذر البحث في سجل التوزيع',
      detail:error instanceof Error?error.message:String(error||'')
    },{status:500});
  }
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لعرض سجل التوزيع',
    tenant_not_found:'المنشأة غير موجودة',
    invalid_report_range:'نطاق التاريخ المحدد غير صالح'
  };
  return messages[value]||value;
}
