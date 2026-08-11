import {NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from '../../../../lib/config';

const ADDON_CENTER_RPC=Object.freeze({
  current:'v3_platform_addon_center_action',
  legacy:'v2_platform_addon_center_action'
});

const RPC={
  'provision-tenant':'v2_platform_provision_tenant',
  'invite-user':'v2_tenant_invite_user',
  'create-plan':'v2_platform_create_plan',
  'create-feature':'v2_platform_create_feature',
  'set-tenant-feature':'v2_platform_set_tenant_feature',
  'set-subscription':'v2_platform_set_subscription',
  'set-tenant-status':'v2_platform_set_tenant_status',
  'create-connection':'v2_platform_upsert_connection',
  'create-support':'v2_support_create_request',
  'update-support':'v2_support_update_request'
  ,'addon-decision':ADDON_CENTER_RPC.current
  ,'marketplace':'v1_platform_marketplace_action'
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
function translate(x){const m={
  forbidden:'ليس لديك صلاحية لتنفيذ العملية',
  display_name_required:'اسم المنشأة مطلوب',
  invalid_slug:'الرابط المختصر غير صالح',
  slug_exists:'هذا الرابط مستخدم بالفعل',
  owner_name_required:'اسم مالك المنشأة مطلوب',
  invalid_owner_email:'بريد مالك المنشأة غير صالح',
  invalid_email:'البريد الإلكتروني غير صالح',
  invalid_hostname:'الدومين غير صالح؛ أدخله دون https أو مسار إضافي',
  domain_exists:'هذا الدومين مرتبط بمنشأة أخرى',
  invalid_role:'الدور المختار غير صالح',
  full_name_required:'اسم المستخدم مطلوب',
  name_required:'الاسم مطلوب',
  tenant_not_found:'المنشأة غير موجودة',
  feature_not_found:'الإضافة غير موجودة',
  plan_not_found:'الباقة غير موجودة أو غير مفعلة',
  invalid_status:'الحالة غير صالحة',
  title_required:'العنوان مطلوب',
  request_not_found:'الطلب غير موجود',
  market_account_not_found:'المنشأة غير موجودة في قاعدة السوق'
  ,invalid_addon_subscription:'معرّف اشتراك الإضافة غير صالح'
  ,addon_subscription_not_found:'اشتراك الإضافة غير موجود'
  ,addon_request_not_pending:'طلب الإضافة لم يعد معلقًا'
  ,invalid_addon_decision:'قرار الإضافة غير صالح'
  ,invalid_addon_limit:'حد الاستخدام غير صالح'
  ,invalid_addon_action:'إجراء الإضافة غير صالح'
  ,addon_product_not_found:'الإضافة غير موجودة أو غير منشورة'
  ,protected_reef_subscription:'ترخيص ريف محمي حتى نهاية سنة الإطلاق؛ يلزم مسار طوارئ موثّق'
  ,protected_addon_subscription_lifecycle:'دورة حياة هذا الترخيص محمية حتى نهاية الفترة المحددة'
  ,invalid_addon_price:'السعر أو تاريخ سريانه غير صالح'
  ,addon_price_version_exists:'يوجد سعر مسجل للإضافة بنفس العملة والتاريخ'
  ,invalid_addon_grant:'بيانات منح الترخيص غير صالحة'
  ,invalid_addon_grant_period:'يجب أن تكون نهاية الترخيص بعد بدايته'
  ,invalid_addon_action_payload:'بيانات عملية الإضافة غير صالحة'
  ,tenant_id_required_for_addon_grant:'اختر المنشأة من القائمة المؤكدة'
  ,tenant_slug_not_allowed_for_addon_grant:'يجب منح الترخيص بمعرّف المنشأة المؤكد لا بالرابط المكتوب'
  ,invalid_addon_grant_currency:'عملة الترخيص غير صالحة'
  ,addon_price_not_found_for_currency:'لا يوجد سعر سنوي ساري بهذه العملة في تاريخ البداية'
  ,protected_override_not_supported:'لا يمكن تجاوز حماية دورة حياة ترخيص ريف من لوحة التحكم'
  ,invalid_addon_subscription_status:'حالة الترخيص غير صالحة'
  ,expired_subscription_requires_new_period:'الترخيص منتهي ويحتاج فترة جديدة بدل إعادة فتحه'
  ,payment_provider_not_found:'وسيلة الدفع غير موجودة'
  ,payment_provider_status_requires_verification:'لا يمكن إعلان وسيلة الدفع نشطة قبل اختبار الخادم والـWebhook'
  ,invalid_payment_provider_environment:'بيئة وسيلة الدفع غير صالحة'
  ,invalid_payment_provider_checkout_mode:'نمط صفحة الدفع غير صالح'
  ,invalid_payment_provider_currencies:'قائمة العملات غير صالحة'
  ,sensitive_payment_provider_config_rejected:'ضع بيانات الاعتماد السرية في الخزنة فقط'
  ,marketplace_order_invalid:'رقم الطلب غير صالح'
  ,marketplace_order_not_found:'طلب المتجر غير موجود'
  ,marketplace_order_not_payable:'هذا الطلب غير قابل لتأكيد الدفع'
  ,marketplace_payment_amount_mismatch:'قيمة الدفع لا تطابق إجمالي الطلب'
  ,marketplace_service_order_invalid:'طلب الخدمة غير صالح لهذا الإجراء'
  ,marketplace_status_invalid:'حالة تنفيذ الخدمة غير صالحة'
  ,marketplace_status_transition_invalid:'لا يمكن نقل الخدمة مباشرة إلى هذه الحالة'
  ,marketplace_order_closed:'الطلب مكتمل ولا يمكن تعديله'
  ,marketplace_webhook_not_found:'إعداد Webhook الدفع غير موجود'
  ,marketplace_action_invalid:'إجراء المتجر غير مدعوم'
};return m[x]||String(x)}
