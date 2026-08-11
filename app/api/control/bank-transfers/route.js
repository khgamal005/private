import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await request.json();
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v3_platform_bank_transfer_action`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store'
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok)return NextResponse.json({error:translate(data?.message||data?.error||data?.detail),detail:data},{status:response.status});
    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({error:'تعذر تنفيذ العملية',detail:error.message},{status:500});
  }
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية إدارة المدفوعات',
    marketplace_order_not_found:'طلب الشراء غير موجود',
    bank_transfer_not_found:'بيانات التحويل غير موجودة',
    bank_transfer_not_reviewable:'لا يمكن مراجعة هذا التحويل في حالته الحالية',
    bank_transfer_already_approved:'تم اعتماد هذا التحويل بالفعل',
    marketplace_order_not_payable:'الطلب لم يعد قابلًا للدفع'
  };
  return messages[String(value||'')]||String(value||'تعذر تنفيذ العملية');
}

