import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const ACTIONS=new Set([
  'save-site','publish-site','publish-saved-page',
  'create-page','update-page','duplicate-page','archive-page','set-home-page',
  'create-menu','update-menu','archive-menu','save-menu-item','archive-menu-item','move-menu-item',
  'create-article','update-article','archive-article',
  'create-category','update-category','archive-category',
  'register-asset','update-asset','archive-asset','set-submission-status'
]);

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action))return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const body=await request.json();
    const siteKey=String(body?.siteKey||'marktone-main').trim();
    const tenantSlug=body?.tenantSlug?String(body.tenantSlug).trim():null;
    const payload=body?.payload&&typeof body.payload==='object'?body.payload:{};
    const rpc=['publish-site','publish-saved-page'].includes(action)?'v3_cms_publication_action':'v3_cms_action';
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_site_key:siteKey,p_tenant_slug:tenantSlug,p_action:action,p_payload:payload}),
      cache:'no-store'
    });
    const data=await parseResponse(response);
    if(!response.ok)return NextResponse.json({error:translate(data),detail:data},{status:response.status});
    return NextResponse.json({success:true,data});
  }catch(error){
    console.error('cms_action_failed',error);
    return NextResponse.json({error:'تعذر تنفيذ العملية الآن',detail:error instanceof Error?error.message:String(error)},{status:500});
  }
}

async function parseResponse(response){
  const text=await response.text();
  try{return JSON.parse(text)}catch{return {detail:text}}
}

function translate(data){
  const text=String(data?.message||data?.error||data?.detail||'');
  const messages={
    cms_publication_conflict:'تغيرت حالة الموقع أو المسودة. حدّث الصفحة وراجع آخر نسخة قبل النشر.',
    cms_home_publish_required:'انشر الصفحة الرئيسية أولًا وتأكد أن الوصول إليها عام أو عبر الرابط.',
    cms_saved_draft_required:'احفظ تصميم الصفحة في المصمم أولًا، ثم انشره من هنا.',
    cms_entity_not_found:'الصفحة غير موجودة في هذا الموقع.',
    authentication_required:'يجب تسجيل الدخول أولًا',forbidden:'ليس لديك الصلاحية المطلوبة',
    cms_addon_required:'إضافة الموقع الاحترافي غير مفعلة لهذه المنشأة',
    cms_unique_value_conflict:'الرابط أو المفتاح مستخدم بالفعل',
    page_slug_invalid:'الرابط المختصر للصفحة غير صالح',page_title_required:'عنوان الصفحة مطلوب',page_not_found:'الصفحة غير موجودة',
    home_page_cannot_archive:'لا يمكن أرشفة الصفحة الرئيسية',publish_forbidden:'ليس لديك صلاحية النشر',
    menu_name_required:'اسم القائمة مطلوب',menu_not_found:'القائمة غير موجودة',system_menu_cannot_archive:'لا يمكن أرشفة القائمة الرئيسية أو الفوتر',
    menu_item_label_required:'اسم عنصر القائمة مطلوب',menu_item_not_found:'عنصر القائمة غير موجود',
    cms_menu_depth_limit:'الحد الأقصى للقوائم الفرعية ثلاثة مستويات',cms_menu_cycle:'لا يمكن جعل العنصر تابعًا لنفسه',
    cms_target_page_invalid:'الصفحة المرتبطة غير صالحة',cms_target_article_invalid:'المقال المرتبط غير صالح',
    article_slug_invalid:'الرابط المختصر للمقال غير صالح',article_title_required:'عنوان المقال مطلوب',article_not_found:'المقال غير موجود',
    category_slug_invalid:'رابط التصنيف غير صالح',category_name_required:'اسم التصنيف مطلوب',category_not_found:'التصنيف غير موجود',
    asset_too_large:'حجم الصورة أكبر من 8 ميجابايت',asset_type_invalid:'نوع الملف غير مدعوم',asset_not_found:'الصورة غير موجودة',
    submission_status_invalid:'حالة الرسالة غير صالحة',submission_not_found:'الرسالة غير موجودة'
  };
  const key=Object.keys(messages).find(item=>text.includes(item));
  return key?messages[key]:'تعذر حفظ التعديلات. راجع البيانات وحاول مرة أخرى.';
}
