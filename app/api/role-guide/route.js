import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../lib/config';

const SNAPSHOT_RPC='v2_tenant_role_guide_snapshot';
const ACTION_RPC='v2_tenant_role_guide_action';

export async function GET(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});

    const {searchParams}=new URL(request.url);
    const tenantSlug=String(searchParams.get('tenantSlug')||'').trim();
    const version=String(searchParams.get('version')||'2026.08.1').trim();
    if(!tenantSlug){
      return NextResponse.json({error:'معرّف المنشأة مطلوب'},{status:400});
    }

    const data=await callRpc(SNAPSHOT_RPC,{
      p_slug:tenantSlug,
      p_version:version
    },token);
    return NextResponse.json({data});
  }catch(error){
    return failure(error);
  }
}

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});

    const body=await request.json().catch(()=>({}));
    const tenantSlug=String(body.tenantSlug||'').trim();
    const action=String(body.action||'').trim();
    const version=String(body.version||'2026.08.1').trim();
    if(!tenantSlug||!action){
      return NextResponse.json({error:'بيانات الدليل غير مكتملة'},{status:400});
    }

    const data=await callRpc(ACTION_RPC,{
      p_slug:tenantSlug,
      p_action:action,
      p_payload:body.payload&&typeof body.payload==='object'
        ?body.payload
        :{},
      p_version:version
    },token);
    return NextResponse.json({success:true,data});
  }catch(error){
    return failure(error);
  }
}

async function callRpc(name,payload,token){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(payload),
    cache:'no-store'
  });
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={detail:text}}
  if(!response.ok){
    const detail=String(
      data?.message||data?.error||data?.detail||'role_guide_request_failed'
    );
    const error=new Error(detail);
    error.status=response.status;
    throw error;
  }
  return data;
}

function failure(error){
  const message=translate(error.message);
  const status=Number(error.status)||(
    error.message==='forbidden'?403:500
  );
  return NextResponse.json({error:message,detail:error.message},{status});
}

function translate(value){
  return ({
    forbidden:'ليس لديك صلاحية لفتح دليل هذه المنشأة',
    tenant_not_found:'المنشأة غير موجودة',
    subject_not_found:'حسابك غير مربوط بملف مستخدم صالح',
    invalid_role_guide_action:'إجراء الدليل غير صالح',
    invalid_guide_version:'إصدار الدليل غير صالح',
    invalid_checklist_item:'عنصر قائمة المهام غير صالح'
  })[value]||'تعذر حفظ أو تحميل دليل وظيفتي';
}
