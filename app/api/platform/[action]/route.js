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
  'update-support':'v2_support_update_request',
  'configure-odeiry-manager':'v1_platform_odeiry_manager_configure',
  'addon-decision':ADDON_CENTER_RPC.current,
  'marketplace':'v1_platform_marketplace_action',
  'commerce':'v4_platform_commerce_action',
  'service-marketplace':'v1_platform_service_marketplace_action'
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
  odeiry_manager_payload_invalid:'بيانات تفعيل أوديري المدير غير صالحة',
  odeiry_manager_version_conflict:'تغيّرت حالة أوديري المدير من جلسة أخرى؛ حدّث الصفحة ثم أعد المحاولة',
  odeiry_runtime_missing:'إعدادات تشغيل أوديري غير متاحة',
  market_account_not_found:'المنشأة غير موجودة في قاعدة السوق',
  invalid_addon_subscription:'معرّف اشتراك الإضافة غير صالح',
  addon_subscription_not_found:'اشتراك الإضافة غير موجود',
  addon_request_not_pending:'طلب الإضافة لم يعد معلقًا',
  invalid_addon_decision:'قرار الإضافة غير صالح',
  invalid_addon_limit:'حد الاستخدام غير صالح',
  invalid_addon_action:'إجراء الإضافة غير صالح',
  addon_product_not_found:'الإضافة غير موجودة أو غير منشورة',
  protected_reef_subscription:'ترخيص ريف محمي حتى نهاية سنة الإطلاق؛ يلزم مسار طوارئ موثّق',
  protected_addon_subscription_lifecycle:'دورة حياة هذا الترخيص محمية حتى نهاية الفترة المحددة',
  invalid_addon_price:'السعر أو تاريخ سريانه غير صالح',
  addon_price_version_exists:'يوجد سعر مسجل للإضافة بنفس العملة والتاريخ',
  invalid_addon_product_update:'بيانات تعديل الإضافة غير صالحة',
  invalid_addon_product_visibility:'حالة ظهور الإضافة في المتجر غير صالحة',
  addon_product_name_required:'اسم الإضافة مطلوب ويجب ألا يتجاوز 120 حرفًا',
  addon_product_name_too_long:'اسم الإضافة الإنجليزي طويل جدًا',
  addon_product_description_required:'وصف بطاقة المتجر مطلوب ويجب أن يكون بين 10 و1000 حرف',
  addon_product_badge_too_long:'شارة العرض يجب ألا تتجاوز 60 حرفًا',
  invalid_addon_product_display_order:'ترتيب ظهور الإضافة غير صالح',
  addon_product_update_reason_required:'اكتب سبب التعديل بوضوح',
  addon_product_update_conflict:'تم تعديل الإضافة من جلسة أخرى؛ حدّث الصفحة ثم أعد المحاولة',
  invalid_addon_grant:'بيانات منح الترخيص غير صالحة',
  invalid_addon_grant_period:'يجب أن تكون نهاية الترخيص بعد بدايته',
  invalid_addon_action_payload:'بيانات عملية الإضافة غير صالحة',
  tenant_id_required_for_addon_grant:'اختر المنشأة من القائمة المؤكدة',
  tenant_slug_not_allowed_for_addon_grant:'يجب منح الترخيص بمعرّف المنشأة المؤكد لا بالرابط المكتوب',
  invalid_addon_grant_currency:'عملة الترخيص غير صالحة',
  addon_price_not_found_for_currency:'لا يوجد سعر سنوي ساري بهذه العملة في تاريخ البداية',
  protected_override_not_supported:'لا يمكن تجاوز حماية دورة حياة ترخيص ريف من لوحة التحكم',
  invalid_addon_subscription_status:'حالة الترخيص غير صالحة',
  expired_subscription_requires_new_period:'الترخيص منتهي ويحتاج فترة جديدة بدل إعادة فتحه',
  payment_provider_not_found:'وسيلة الدفع غير موجودة',
  payment_provider_status_requires_verification:'لا يمكن إعلان وسيلة الدفع نشطة قبل اختبار الخادم والـWebhook',
  invalid_payment_provider_environment:'بيئة وسيلة الدفع غير صالحة',
  invalid_payment_provider_checkout_mode:'نمط صفحة الدفع غير صالح',
  invalid_payment_provider_currencies:'قائمة العملات غير صالحة',
  sensitive_payment_provider_config_rejected:'ضع بيانات الاعتماد السرية في الخزنة فقط',
  marketplace_order_invalid:'رقم الطلب غير صالح',
  marketplace_order_not_found:'طلب المتجر غير موجود',
  marketplace_order_not_payable:'هذا الطلب غير قابل لتأكيد الدفع',
  marketplace_payment_amount_mismatch:'قيمة الدفع لا تطابق إجمالي الطلب',
  marketplace_service_order_invalid:'طلب الخدمة غير صالح لهذا الإجراء',
  marketplace_status_invalid:'حالة تنفيذ الخدمة غير صالحة',
  marketplace_status_transition_invalid:'لا يمكن نقل الخدمة مباشرة إلى هذه الحالة',
  marketplace_order_closed:'الطلب مكتمل ولا يمكن تعديله',
  marketplace_webhook_not_found:'إعداد Webhook الدفع غير موجود',
  marketplace_action_invalid:'إجراء المتجر غير مدعوم',
  plan_name_required:'اسم الباقة مطلوب',
  invalid_plan_key:'مفتاح الباقة يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  invalid_plan_status:'حالة الباقة غير صالحة',
  invalid_plan_interval:'دورة فوترة الباقة غير صالحة',
  invalid_plan_price:'سعر الباقة غير صالح',
  invalid_plan_limit:'أحد حدود الباقة غير صالح',
  plan_limit_reached:'وصلت المنشأة إلى الحد الأقصى المسموح به في باقتها',
  invalid_subscription_status:'حالة الاشتراك غير صالحة',
  invalid_subscription_period:'يجب أن تكون نهاية الاشتراك بعد بدايته',
  category_name_required:'اسم القسم مطلوب',
  invalid_category_key:'مفتاح القسم يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  category_not_found:'القسم غير موجود أو غير نشط',
  service_name_required:'اسم الخدمة مطلوب',
  invalid_service_key:'مفتاح الخدمة يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  service_not_found:'الخدمة غير موجودة',
  service_provider_invalid:'بيانات مزود الخدمة غير صالحة',
  service_provider_name_required:'اسم مزود الخدمة مطلوب',
  service_provider_key_invalid:'مفتاح مزود الخدمة يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  service_provider_not_found:'مزود الخدمة غير موجود',
  service_provider_not_available:'مزود الخدمة غير متاح للإسناد',
  service_provider_update_conflict:'تم تعديل بيانات المزود من جلسة أخرى؛ حدّث الصفحة وأعد المحاولة',
  service_course_invalid:'بيانات الدورة غير صالحة',
  service_course_key_invalid:'مفتاح الدورة يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  service_course_not_found:'الدورة غير موجودة',
  service_course_update_conflict:'تم تعديل الدورة من جلسة أخرى؛ حدّث الصفحة وأعد المحاولة',
  service_course_provider_locked:'لا يمكن تغيير مزود دورة مرتبطة بخدمة؛ أنشئ دورة جديدة أو فك الارتباط أولًا',
  service_product_invalid:'بيانات الخدمة غير صالحة',
  service_description_required:'اكتب وصفًا واضحًا للخدمة',
  service_price_invalid:'سعر الخدمة غير صالح',
  service_product_update_conflict:'تم تعديل الخدمة من جلسة أخرى؛ حدّث الصفحة وأعد المحاولة',
  service_package_invalid:'بيانات الباقة غير صالحة',
  service_package_key_invalid:'مفتاح الباقة يجب أن يكون إنجليزيًا وبصيغة صحيحة',
  service_package_not_found:'باقة الخدمة غير موجودة',
  service_package_update_conflict:'تم تعديل الباقة من جلسة أخرى؛ حدّث الصفحة وأعد المحاولة',
  service_package_product_locked:'لا يمكن نقل باقة قائمة إلى خدمة أخرى',
  service_assignment_invalid:'بيانات إسناد الطلب غير صالحة',
  service_assignment_order_not_ready:'يجب تأكيد دفع الطلب قبل إسناده',
  service_assignment_update_conflict:'تم تعديل الإسناد من جلسة أخرى؛ حدّث الصفحة وأعد المحاولة',
  service_assignment_package_locked:'باقة الطلب جزء من الشراء ولا يمكن تغييرها أثناء الإسناد',
  service_marketplace_action_invalid:'إجراء إدارة متجر الخدمات غير مدعوم',
  commerce_action_invalid:'إجراء إدارة المنتجات والفوترة غير مدعوم'
};return m[x]||String(x)}
