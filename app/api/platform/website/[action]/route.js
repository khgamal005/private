import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

const ACTIONS=new Set([
  'save-site','save-menu-item','delete-menu-item','save-section','delete-section',
  'save-page','delete-page','save-article','delete-article','set-submission-status'
]);

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action)){
      return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    }

    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const payload=await request.json();
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_platform_site_action`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({p_action:action,p_payload:payload}),
      cache:'no-store'
    });
    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      return NextResponse.json({
        error:translate(data?.message||data?.error||data?.detail),
        detail:data
      },{status:response.status});
    }
    return NextResponse.json({success:true,data});
  }catch(error){
    console.error('platform_website_action_failed',error);
    return NextResponse.json({error:'تعذر حفظ التعديلات',detail:error.message},{status:500});
  }
}

function translate(value){
  const text=String(value||'');
  const messages={
    authentication_required:'يجب تسجيل الدخول أولًا',
    forbidden:'ليس لديك صلاحية إدارة الموقع',
    website_unique_value_conflict:'يوجد رابط أو مفتاح مستخدم بالفعل',
    website_payload_invalid:'بعض القيم المدخلة غير صالحة',
    menu_item_required_fields:'اسم عنصر القائمة والرابط مطلوبان',
    menu_item_not_found:'عنصر القائمة غير موجود',
    section_key_invalid:'مفتاح القسم يجب أن يكون إنجليزيًا دون مسافات',
    section_title_required:'عنوان القسم مطلوب',
    section_not_found:'القسم غير موجود',
    page_slug_invalid:'رابط الصفحة يجب أن يكون إنجليزيًا دون مسافات',
    page_title_required:'عنوان الصفحة مطلوب',
    page_not_found:'الصفحة غير موجودة',
    article_slug_invalid:'رابط المقال يجب أن يكون إنجليزيًا دون مسافات',
    article_title_required:'عنوان المقال مطلوب',
    article_not_found:'المقال غير موجود',
    submission_status_invalid:'حالة الرسالة غير صالحة',
    submission_not_found:'الرسالة غير موجودة'
  };
  const key=Object.keys(messages).find(item=>text.includes(item));
  return key?messages[key]:'تعذر حفظ التعديلات. راجع البيانات وحاول مرة أخرى.';
}
