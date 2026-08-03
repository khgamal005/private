import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

const ACTIONS=new Set(['save-draft','publish','restore-version']);

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action))return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    const body=await request.json();
    const pageId=String(body?.pageId||'').trim();
    if(!/^[0-9a-f-]{36}$/i.test(pageId))return NextResponse.json({error:'الصفحة غير محددة'},{status:400});
    const payload={...body};delete payload.pageId;
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_platform_page_builder_action`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_action:action,p_page_id:pageId,p_payload:payload}),
      cache:'no-store'
    });
    const text=await response.text();let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok)return NextResponse.json({error:translate(data?.message||data?.error||data?.detail),detail:data},{status:response.status});
    return NextResponse.json({success:true,data});
  }catch(error){
    console.error('website_builder_action_failed',error);
    return NextResponse.json({error:'تعذر تنفيذ عملية المصمم',detail:error.message},{status:500});
  }
}

function translate(value){
  const text=String(value||'');
  const messages={
    authentication_required:'يجب تسجيل الدخول أولًا',forbidden:'ليس لديك صلاحية تصميم الموقع',
    page_not_found:'الصفحة غير موجودة',builder_document_invalid:'بيانات التصميم غير صالحة',
    builder_document_too_large:'حجم الصفحة أكبر من الحد المسموح',builder_blocks_limit:'عدد العناصر أكبر من الحد المسموح',
    builder_block_invalid:'يوجد عنصر غير صالح داخل الصفحة',builder_block_type_invalid:'نوع أحد العناصر غير مدعوم',
    builder_version_not_found:'الإصدار المطلوب غير موجود',builder_action_invalid:'عملية المصمم غير مدعومة'
  };
  const key=Object.keys(messages).find(item=>text.includes(item));
  return key?messages[key]:'تعذر تنفيذ العملية. راجع بيانات الصفحة وحاول مرة أخرى.';
}
