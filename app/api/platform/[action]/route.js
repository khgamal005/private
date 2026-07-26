import {NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from '../../../../lib/config';

const RPC={
  'provision-tenant':'v2_platform_provision_tenant',
  'create-plan':'v2_platform_create_plan',
  'create-feature':'v2_platform_create_feature',
  'set-tenant-feature':'v2_platform_set_tenant_feature',
  'set-subscription':'v2_platform_set_subscription',
  'set-tenant-status':'v2_platform_set_tenant_status',
  'create-connection':'v2_platform_upsert_connection',
  'create-support':'v2_support_create_request',
  'update-support':'v2_support_update_request'
};

export async function POST(req,{params}){
  try{
    const {action}=await params;
    const rpc=RPC[action];
    if(!rpc)return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await req.json();
    const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store'
    });
    const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!r.ok)return NextResponse.json({error:translate(data?.message||data?.detail||'تعذر تنفيذ العملية'),detail:data},{status:r.status});
    return NextResponse.json({success:true,data});
  }catch(e){return NextResponse.json({error:'تعذر تنفيذ العملية',detail:e.message},{status:500})}
}
function translate(x){const m={forbidden:'ليس لديك صلاحية لتنفيذ العملية',display_name_required:'اسم المنشأة مطلوب',invalid_slug:'الرابط المختصر غير صالح',slug_exists:'هذا الرابط مستخدم بالفعل',name_required:'الاسم مطلوب',tenant_not_found:'المنشأة غير موجودة',feature_not_found:'الإضافة غير موجودة',plan_not_found:'الباقة غير موجودة',invalid_status:'الحالة غير صالحة',title_required:'العنوان مطلوب',request_not_found:'الطلب غير موجود',market_account_not_found:'المنشأة غير موجودة في قاعدة السوق'};return m[x]||String(x)}
