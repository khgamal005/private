import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

const ACTIONS=new Set(['save-draft','publish','restore-version']);

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action))return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const body=await request.json();
    const entityId=String(body?.entityId||'').trim();
    const entityType=String(body?.entityType||'page').trim();
    if(!/^[0-9a-f-]{36}$/i.test(entityId))return NextResponse.json({error:'المحتوى غير محدد'},{status:400});
    if(!['page','article'].includes(entityType))return NextResponse.json({error:'نوع المحتوى غير مدعوم'},{status:400});
    const payload={};
    if(body?.document)payload.document=body.document;
    if(body?.versionId)payload.versionId=body.versionId;
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v3_cms_builder_action`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        p_site_key:String(body?.siteKey||'marktone-main'),
        p_tenant_slug:body?.tenantSlug||null,
        p_entity_type:entityType,
        p_entity_id:entityId,
        p_action:action,
        p_payload:payload
      }),
      cache:'no-store'
    });
    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok)return NextResponse.json({error:translate(data),detail:data},{status:response.status});
    return NextResponse.json({success:true,data});
  }catch(error){
    console.error('cms_builder_action_failed',error);
    return NextResponse.json({error:'تعذر تنفيذ عملية المصمم',detail:error instanceof Error?error.message:String(error)},{status:500});
  }
}

function translate(data){
  const text=String(data?.message||data?.error||data?.detail||'');
  const messages={
    authentication_required:'يجب تسجيل الدخول أولًا',forbidden:'ليس لديك صلاحية التصميم',
    cms_addon_required:'إضافة الموقع الاحترافي غير مفعلة',publish_forbidden:'ليس لديك صلاحية النشر',
    cms_entity_not_found:'المحتوى غير موجود',cms_entity_type_invalid:'نوع المحتوى غير مدعوم',
    builder_document_invalid:'بيانات التصميم غير صالحة',builder_document_too_large:'حجم التصميم أكبر من الحد المسموح',
    builder_blocks_limit:'عدد عناصر الصفحة أكبر من الحد المسموح',builder_block_invalid:'يوجد عنصر غير صالح',
    builder_block_type_invalid:'نوع أحد العناصر غير مدعوم',builder_version_not_found:'الإصدار المطلوب غير موجود',
    builder_action_invalid:'عملية المصمم غير مدعومة'
  };
  const key=Object.keys(messages).find(item=>text.includes(item));
  return key?messages[key]:'تعذر تنفيذ العملية. راجع التصميم وحاول مرة أخرى.';
}
