import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});

    const body=await request.json();
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_tenant_marketplace_action`,{
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
      return NextResponse.json({error:translate(data?.message||data?.error||data?.detail),detail:data},{status:response.status});
    }
    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({error:'تعذر تنفيذ العملية',detail:error.message},{status:500});
  }
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لإدارة اشتراكات المنشأة',
    tenant_not_found:'المنشأة غير موجودة',
    marketplace_product_not_found:'الإضافة غير متاحة حاليًا',
    marketplace_payment_provider_unavailable:'وسيلة الدفع غير متاحة حاليًا',
    marketplace_order_not_found:'طلب الشراء غير موجود',
    marketplace_order_not_payable:'طلب الشراء لا يقبل الدفع الآن',
    marketplace_payment_provider_mismatch:'وسيلة الدفع لا تطابق الطلب',
    bank_transfer_reference_required:'أدخل مرجع التحويل البنكي',
    bank_transfer_sender_required:'أدخل اسم المحوّل',
    bank_transfer_date_invalid:'تاريخ التحويل غير صالح',
    bank_transfer_already_approved:'تم اعتماد هذا التحويل بالفعل'
  };
  return messages[String(value||'')]||String(value||'تعذر تنفيذ العملية');
}

