import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {WOO_ADMISSION_ERRORS} from '../../../../lib/woocommerce-admissions.mjs';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const ADDON_CENTER_RPC=Object.freeze({
  current:'v3_tenant_addon_center_action',
  legacy:'v2_tenant_addon_center_action'
});

const RPC={
  'operating-foundation':'v1_tenant_operating_action',
  'operating-snapshot':'v1_tenant_operating_snapshot',
  'admission-governance':'v1_tenant_admission_governance_action',
  'admission-governance-snapshot':'v1_tenant_admission_governance_snapshot',
  'create-staff':'v2_tenant_create_staff',
  'update-staff':'v2_tenant_update_staff',
  'invite-staff':'v2_tenant_invite_staff',
  'create-course':'v2_tenant_create_course',
  'create-contact':'v2_tenant_create_contact',
  'create-sales-lead':'v2_tenant_create_sales_lead',
  'update-sales-contact':'v2_tenant_update_sales_contact_v1',
  'lead-intake':'v2_tenant_lead_intake_action',
  'lead-assignment-search':'v1_tenant_lead_assignment_search',
  'lead-reassignment':'v1_tenant_lead_reassignment_action',
  'woocommerce-order-routing':'v4_tenant_commerce_order_action',
  'woocommerce-admission-context':'v1_tenant_woocommerce_admission_context',
  'woocommerce-admission-action':'v1_tenant_woocommerce_admission_action',
  'woocommerce-admission-preview':'v1_tenant_woocommerce_admission_preview',
  'record-sales-followup':'v2_tenant_record_sales_followup_v5',
  'sales-followup-context':'v1_tenant_sales_followup_context',
  'sales-followup-options':'v1_tenant_sales_followup_options',
  'update-admission':'v2_tenant_update_admission',
  'update-admission-document':'v2_tenant_update_admission_document',
  'save-course-run':'v2_tenant_save_course_run',
  'update-training-operation':'v2_tenant_update_training_operation',
  'training-automation':'v2_tenant_training_automation_action',
  'automation-studio':'v2_tenant_automation_studio_action_v2',
  'delivery-analytics':'v2_tenant_delivery_analytics_action_v2',
  'addon-center':ADDON_CENTER_RPC.current,
  'marketplace':'v1_tenant_marketplace_action',
  'service-marketplace':'v2_tenant_service_marketplace_action',
  'integration-hub':'v2_tenant_integration_hub_action',
  'create-opportunity':'v3_tenant_create_opportunity',
  'move-opportunity':'v2_tenant_move_opportunity',
  'log-activity':'v2_tenant_log_activity',
  'create-task':'v2_tenant_create_task',
  'update-task-status':'v3_tenant_update_task_status',
  'transition-task':'v4_tenant_transition_task',
  'calendar-day':'v6_tenant_calendar_day_snapshot'
};

const ACTION_ADDONS=Object.freeze({
  'automation-studio':['automation'],
  'delivery-analytics':['delivery_analytics'],
  'integration-hub':['whatsapp','email','api','templates']
});

async function checkAddonAccess({action,body,token}){
  const required=ACTION_ADDONS[action]||null;
  if(!required)return {ok:true};
  const slug=body?.p_tenant_slug||body?.p_slug||body?.tenantSlug;
  if(!slug)return {ok:false,status:400,error:'tenant_slug_required'};
  const response=await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/v3_tenant_addon_navigation_snapshot`,
    {
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({p_slug:slug}),
      cache:'no-store'
    }
  );
  if(!response.ok){
    return {
      ok:false,
      status:[401,403].includes(response.status)?response.status:503,
      error:'addon_access_check_failed'
    };
  }
  const snapshot=await response.json();
  const enabled=new Set(snapshot?.enabledProductKeys||[]);
  return required.some(productKey=>enabled.has(productKey))
    ?{ok:true}
    :{ok:false,status:403,error:'addon_not_enabled'};
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    let rpc=RPC[action];
    if(!rpc&&action!=='integration-test'){
      return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    }

    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const body=await request.json();
    // Old open tabs keep the V5 contract; structured details always use V6 atomically.
    if(action==='record-sales-followup'&&Object.hasOwn(body,'p_course_interests')){
      rpc=Object.hasOwn(body,'p_opportunity_id')?'v2_tenant_record_sales_followup_v7':'v2_tenant_record_sales_followup_v6';
    }
    // Service orders share the canonical payment ledger. Route bank-transfer
    // evidence through the payment-aware V2 contract without exposing add-on
    // catalog actions in the services storefront.
    if(action==='service-marketplace'
       &&body?.p_action==='submit_bank_transfer'){
      rpc='v2_tenant_marketplace_action';
    }
    const addonAccess=await checkAddonAccess({action,body,token});
    if(!addonAccess.ok){
      return NextResponse.json(
        {error:translate(addonAccess.error)},
        {status:addonAccess.status}
      );
    }
    const endpoint=action==='integration-test'
      ?`${SUPABASE_URL}/functions/v1/training-automation-dispatch`
      :`${SUPABASE_URL}/rest/v1/rpc/${rpc}`;
    const response=await fetch(endpoint,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(
        action==='integration-test'
          ?{...body,action:'test_connection'}
          :body
      ),
      cache:'no-store'
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      return NextResponse.json({
        error:translate(
          data?.message
          ||data?.error
          ||data?.detail
          ||'تعذر تنفيذ العملية'
        ),
        detail:data
      },{status:response.status});
    }

    return NextResponse.json(
      action==='integration-test'
        ?data
        :{success:true,data}
    );
  }catch(error){
    return NextResponse.json({
      error:'تعذر تنفيذ العملية',
      detail:error.message
    },{status:500});
  }
}

function translate(value){
  const messages={
    commercial_terms_invoice_mismatch:'السعر المتفق عليه لا يطابق صافي الفاتورة؛ راجع الاتفاق والمستند المالي.',
    issued_invoice_required:'اربط فاتورة صادرة وصحيحة قبل استكمال القبول.',
    refund_invoice_allocation_required:'اربط الاسترداد بالفاتورة التي خُصصت لها الدفعة.',
    course_run_sessions_not_completed:'أكمل حالة جلسات الدفعة قبل إغلاقها.',
    agreed_price_required:'حدد السعر المتفق عليه واعتمده قبل استكمال القبول.',
    payment_currency_mismatch:'عملة الدفعة لا تطابق عملة الاتفاق المالي.',
    late_enrollment_approval_required:'الالتحاق بعد بدء الدفعة يحتاج موافقة مخولة وسببًا مسجلًا.',
    course_run_unavailable:'الدفعة غير متاحة للتسجيل؛ راجع حالتها وسعتها.',
    required_documents_incomplete:'استكمل المستندات المطلوبة أو سجل استثناءً مخولًا.',
    attendance_unrecorded_blocks_closure:'يوجد حضور غير مسجل؛ استكمله أو سجل استثناء إغلاق مخولًا.',
    course_run_sessions_not_ended:'لا يمكن إغلاق الدفعة قبل انتهاء جلساتها.',
    recorded_session_cannot_be_removed:'لا يمكن حذف جلسة لها سجل حضور.',
    recorded_session_schedule_locked:'لا يمكن تغيير موعد جلسة لها سجل حضور.',
    sla_owners_required:'حدد مسؤول المالية ومسؤول التسكين ومهل المتابعة.',
    policy_preview_required:'راجع معاينة أثر سياسة القبول قبل تأكيد التفعيل.',
    document_exception_permission_required:'استثناء المستندات يحتاج صلاحية مخولة وسببًا مسجلًا.',
    use_diploma_contract_waiver:'سجل استثناء القبول من عقد الدبلوم؛ الاستثناء لا يسقط المديونية.',
    admission_governance_disabled:'فعّل سياسة القبول بعد مراجعة معاينة أثرها.',
    invalid_enrollment_handoff:'طلب التسجيل لا يطابق الطالب أو البرنامج المحدد.',
    operating_setup_version_conflict:'تغيرت إعدادات التشغيل. أعد تحميل الصفحة قبل الحفظ.',
    operating_basic_data_required:'اسم المنشأة واسمها القانوني مطلوبان.',
    operating_timezone_invalid:'اختر منطقة زمنية صحيحة.',
    operating_intake_required:'اختر مصدر استقبال العملاء.',
    operating_timezone_confirmation_required:'أكد تغيير المنطقة الزمنية بعد مراجعة أثره على مواعيد العمل.',
    operating_finance_timezone_permission_required:'مزامنة توقيت الحسابات تحتاج صلاحية إدارة إعدادات الحسابات.',
    operating_setup_required:'استكمل إعداد التشغيل أولًا.',
    operating_preview_confirmation_required:'أعد معاينة أثر السياسة ثم أكد التفعيل.',
    operating_enabled_required:'حدد تفعيل سياسة الورديات أو إيقافها.',
    operating_staff_shifts_required:'أضف ورديات الموظفين النشطين قبل تفعيل التوزيع حسب التوفر.',
    operating_primary_department_required:'اختر قسمًا أساسيًا نشطًا للموظف.',
    operating_branch_required:'اختر فرعًا نشطًا للموظف.',
    operating_staff_payload_invalid:'راجع بيانات الأقسام والورديات.',
    operating_too_many_shifts:'الحد الأقصى 28 فترة عمل أسبوعية.',
    operating_primary_department_duplicated:'القسم الأساسي لا يُكرر ضمن الأقسام الإضافية.',
    operating_department_invalid:'القسم غير متاح ضمن هذه المنشأة.',
    operating_cover_department_invalid:'موظف التغطية يجب أن يكون نشطًا وعضوًا في القسم نفسه.',
    operating_absence_not_found:'سجل الغياب غير موجود.',
    operating_assignee_unavailable:'الموظف غير متاح حاليًا بحسب الوردية أو الإجازة. اختر موظفًا متاحًا.',
    plan_limit_reached:'وصلت المنشأة إلى الحد الأقصى لحسابات الموظفين في باقتها. زد السعة أو أوقف حسابًا غير مستخدم ثم أعد المحاولة.',
    ...WOO_ADMISSION_ERRORS,
    forbidden:'ليس لديك صلاحية لتنفيذ العملية',
    tenant_not_found:'المنشأة غير موجودة',
    full_name_required:'اسم الموظف مطلوب',
    contact_name_required:'اسم العميل مطلوب ويجب ألا يقل عن حرفين',
    contact_name_too_long:'اسم العميل طويل جدًا؛ الحد الأقصى 150 حرفًا',
    invalid_phone:'رقم الجوال غير صالح',
    primary_phone_required:'رقم الجوال الأساسي مطلوب. أكمل بيانات العميل أولًا.',
    additional_phone_limit:'الحد الأقصى جوال أساسي وأربعة أرقام إضافية، ويشمل ذلك واتساب المختلف.',
    contact_owner_required:'كل فرص العميل تتبع المسؤول نفسه. استخدم تغيير إسناد العميل مع تسجيل السبب.',
    training_course_required:'اختر البرنامج التدريبي لهذه الفرصة.',
    invalid_opportunity_kind:'نوع الفرصة غير صالح.',
    next_action_pair_required:'حدد نوع الإجراء وموعده معًا، أو اتركهما معًا دون تحديد.',
    opportunity_command_conflict:'طلب إنشاء الفرصة تغير. أغلق النافذة وأعد المحاولة.',
    open_opportunity_exists:'توجد فرصة مفتوحة لهذا العميل والبرنامج. تابع الفرصة الحالية أولًا.',
    ambiguous_open_opportunity:'يوجد أكثر من فرصة مفتوحة لنفس البرنامج. يحتاج المسؤول إلى مراجعتها قبل تسجيل المتابعة.',
    invalid_attribution:'بيانات مصدر الفرصة أطول من الحد المسموح.',
    followup_opportunity_required:'اختر الفرصة التي تخصها هذه المتابعة.',
    invalid_followup_opportunity:'هذه الفرصة لم تعد مفتوحة لهذا العميل. حدّث البيانات.',
    payment_opportunity_mismatch:'دورة بلاغ الدفع يجب أن تطابق برنامج الفرصة المحددة.',
    opportunity_under_admissions:'الفرصة مرتبطة بعملية دفع أو تسجيل. عالجها من مسار التسجيل والمالية.',
    payment_confirmation_required:'لا تُغلق الفرصة كمباعة قبل تحقق المالية من الدفعة المطلوبة.',
    sales_task_requires_followup:'هذه متابعة مبيعات مرتبطة بفرصة. سجل نتيجة المتابعة وموعدها من شاشة المبيعات حتى تتحدث الفرصة والتقويم معًا.',
    duplicate_additional_phone:'هذا الرقم موجود بالفعل ضمن أرقام العميل',
    duplicate_or_missing_course:'اختر دورة صحيحة دون تكرار الدورة نفسها',
    invalid_attendance_session:'موعد الحضور غير متاح أو لا يتبع الدفعة المختارة؛ راجع الاختيار',
    invalid_followup_details:'راجع الدورات والأرقام؛ الحد الأقصى ٢٠ دورة وجوال أساسي وأربعة أرقام إضافية تشمل واتساب المختلف',
    payment_course_required:'حدد الدورة التي يخصها بلاغ الدفع من الدورات المختارة',
    followup_changed_reload:'تغيرت بيانات العميل في جلسة أخرى. أعد فتح المتابعة لمراجعة أحدث البيانات قبل الحفظ',
    followup_reload_required:'أعد فتح شاشة المتابعة لتحميل بيانات العميل',
    followup_command_conflict:'تعذر تكرار طلب الحفظ ببيانات مختلفة؛ أعد فتح المتابعة',
    invalid_whatsapp:'رقم واتساب غير صالح',
    contact_identity_required:'يجب إدخال رقم جوال أو واتساب أو بريد إلكتروني',
    duplicate_contact_identity:'يوجد عميل آخر مسجل بنفس الجوال أو واتساب أو البريد الإلكتروني',
    organization_name_too_long:'اسم الجهة طويل جدًا',
    contact_notes_too_long:'ملاحظات العميل طويلة جدًا؛ الحد الأقصى 2000 حرف',
    invalid_role:'الدور المختار غير صالح',
    invalid_email:'البريد الإلكتروني غير صالح',
    staff_exists:'الموظف مسجل بالفعل بنفس الدور',
    staff_not_found:'ملف الموظف غير موجود',
    staff_email_exists:'البريد مستخدم في ملف موظف آخر',
    staff_account_already_active:'حساب الموظف نشط بالفعل',
    active_account_email_locked:'لا يمكن تغيير بريد حساب نشط من الملف الوظيفي',
    cannot_remove_own_admin_access:'لا يمكنك إزالة صلاحيتك الإدارية من حسابك الحالي',
    invalid_employment_status:'الحالة الوظيفية غير صالحة',
    invalid_capacity:'الطاقة الأسبوعية خارج النطاق المسموح',
    course_title_required:'اسم الدورة مطلوب',
    course_code_required:'كود الدورة مطلوب',
    course_exists:'توجد دورة مسجلة بهذا الكود',
    invalid_delivery_mode:'طريقة تقديم الدورة غير صالحة'
    ,invalid_owner:'مسؤول المتابعة غير صالح'
    ,invalid_course:'الدورة المختارة غير صالحة'
    ,invalid_contact:'العميل المختار غير صالح'
    ,invalid_stage:'مرحلة المبيعات غير صالحة'
    ,invalid_value:'قيمة الفرصة غير صالحة'
    ,invalid_activity_type:'نوع النشاط غير صالح'
    ,invalid_assignee:'الموظف المسند إليه غير صالح'
    ,invalid_priority:'أولوية المهمة غير صالحة'
    ,invalid_task_status:'حالة المهمة غير صالحة'
    ,task_not_followup:'مهمة المتابعة المحددة غير صالحة أو لم تعد مفتوحة'
    ,task_transition_conflict:'تم تغيير المهمة في جلسة أخرى؛ حدّث التقويم وحاول مجددًا'
    ,task_transition_required:'لم يتم إجراء أي تغيير على المهمة'
    ,task_note_too_long:'ملاحظة الإجراء أطول من الحد المسموح'
    ,task_closed:'المهمة مغلقة؛ أعد فتحها أولًا قبل نقل موعدها'
    ,invalid_calendar_day:'تاريخ اليوم المطلوب غير صالح'
    ,too_many_calendar_tasks:'عدد المهام المطلوب عرضه يتجاوز الحد المسموح'
    ,invalid_lead_status:'حالة العميل غير صالحة'
    ,invalid_lead_quality:'تقييم جودة الليد غير صالح'
    ,invalid_next_action:'نوع الإجراء التالي غير صالح'
    ,invalid_course_run:'الدفعة المختارة غير صالحة لهذه الدورة'
    ,staff_account_not_linked:'يجب ربط حساب الدخول بملف الموظف أولًا'
    ,title_required:'العنوان مطلوب'
    ,phone_required:'رقم الجوال أو واتساب مطلوب'
    ,summary_required:'ملخص النشاط مطلوب'
    ,next_action_required:'يجب تحديد الإجراء التالي وموعده'
    ,course_required_for_payment:'يجب تحديد الدورة قبل تسليم العميل إلى التسجيل والقبول'
    ,closure_reason_required:'يجب كتابة سبب واضح لإغلاق العميل'
    ,lead_under_admissions:'العميل الآن مع التسجيل والقبول ولا يمكن تأكيده من المبيعات'
    ,invalid_admission_action:'إجراء التسجيل والقبول غير صالح'
    ,admission_not_found:'طلب التسجيل غير موجود'
    ,admission_closed:'طلب التسجيل مغلق ولا يقبل هذا التعديل'
    ,invalid_admission_transition:'لا يمكن نقل طلب التسجيل إلى هذه الحالة'
    ,invalid_payment_transition:'لا يمكن تغيير حالة الدفع بهذه الطريقة'
    ,payment_not_verified:'يجب التحقق من الدفع أولًا'
    ,course_run_required:'يجب تحديد الدفعة قبل إكمال التسجيل'
    ,course_run_full:'الدفعة المحددة وصلت إلى طاقتها القصوى'
    ,course_run_not_open:'الدفعة ليست مفتوحة للتسجيل'
    ,course_run_registration_not_started:'لم يبدأ التسجيل في هذه الدفعة بعد'
    ,course_run_registration_closed:'انتهى موعد التسجيل في هذه الدفعة'
    ,batch_title_required:'اسم الدفعة مطلوب'
    ,invalid_course_run_status:'حالة الدفعة غير صالحة'
    ,invalid_course_run_capacity:'سعة الدفعة غير صالحة'
    ,invalid_course_run_price:'سعر الدفعة غير صالح'
    ,invalid_course_run_dates:'تاريخ بداية ونهاية الدفعة غير صالح'
    ,invalid_registration_window:'فترة فتح وإغلاق التسجيل غير صالحة'
    ,registration_after_batch_start:'يجب إغلاق التسجيل قبل بداية الدفعة'
    ,course_run_start_must_be_future:'يجب أن تكون بداية الدفعة المفتوحة في تاريخ قادم'
    ,invalid_course_run_sessions:'جدول المحاضرات غير صالح'
    ,too_many_course_run_sessions:'عدد المحاضرات أكبر من الحد المسموح'
    ,course_run_sessions_required:'أضف محاضرة واحدة على الأقل قبل فتح الدفعة'
    ,invalid_course_run_session_dates:'موعد إحدى المحاضرات غير صالح'
    ,session_outside_course_run:'يوجد موعد محاضرة خارج بداية أو نهاية الدفعة'
    ,course_run_sessions_overlap:'يوجد تعارض بين مواعيد المحاضرات'
    ,course_run_exists:'يوجد كود دفعة مطابق داخل المنشأة'
    ,course_run_not_found:'الدفعة غير موجودة'
    ,course_run_course_locked:'لا يمكن تغيير دورة دفعة بها متدربون'
    ,capacity_below_enrolled:'لا يمكن جعل السعة أقل من عدد المسجلين'
    ,course_run_has_enrollments:'لا يمكن إلغاء أو إعادة هذه الدفعة لوجود متدربين بها'
    ,invalid_course_run_transition:'لا يمكن نقل الدفعة إلى هذه الحالة'
    ,course_run_not_operational:'الدفعة ليست في حالة تسمح بتشغيل المتدربين'
    ,enrollment_not_found:'تسجيل المتدرب غير موجود'
    ,enrollment_inactive:'لا يمكن تسجيل التشغيل لمتدرب منسحب أو ملغي'
    ,invalid_training_record:'بيانات المتدرب والجلسة غير مترابطة'
    ,invalid_training_action:'إجراء تشغيل المتدرب غير صالح'
    ,invalid_session:'الجلسة المختارة غير صالحة'
    ,session_cancelled:'لا يمكن تسجيل حضور جلسة ملغاة'
    ,invalid_attendance_status:'حالة الحضور غير صالحة'
    ,late_minutes_required:'حدد عدد دقائق التأخير'
    ,invalid_late_minutes:'دقائق التأخير تستخدم مع حالة متأخر فقط'
    ,invalid_assessment_score:'نتيجة التقييم غير صالحة'
    ,invalid_assessment_max_score:'الدرجة القصوى للتقييم غير صالحة'
    ,invalid_communication_channel:'قناة إرسال رسالة الانضمام غير صالحة'
    ,invalid_training_automation_action:'إجراء الأتمتة غير صالح'
    ,automation_job_not_found:'مهمة الأتمتة غير موجودة'
    ,automation_job_not_retryable:'لا يمكن إعادة محاولة هذه المهمة في حالتها الحالية'
    ,automation_job_already_sent:'المهمة أُرسلت بالفعل ولا يمكن إلغاؤها'
    ,training_contact_channel_missing:'لا توجد وسيلة تواصل صالحة للمتدرب'
    ,invalid_integration_hub_action:'إجراء الربط غير صالح'
    ,invalid_integration_provider:'مزود الربط المختار غير صالح'
    ,integration_addon_not_enabled:'هذه الإضافة غير مفعلة ضمن باقة المنشأة'
    ,invalid_integration_connection:'معرّف الربط غير صالح'
    ,integration_connection_not_found:'إعداد الربط غير موجود'
    ,integration_provider_locked:'لا يمكن تغيير نوع المزود بعد إنشاء الربط'
    ,integration_https_required:'رابط المزود يجب أن يكون HTTPS آمنًا'
    ,invalid_sender_email:'بريد الإرسال غير صالح'
    ,invalid_aws_region:'منطقة Amazon AWS غير صالحة'
    ,invalid_meta_api_version:'إصدار Meta Graph API غير صالح'
    ,invalid_integration_secret:'بيانات API المرسلة لا تخص هذا المزود'
    ,template_body_required:'نص الرسالة مطلوب'
    ,template_body_too_long:'نص الرسالة أطول من الحد المسموح'
    ,template_subject_too_long:'عنوان الرسالة أطول من الحد المسموح'
    ,invalid_template_variable:'يحتوي القالب على متغير تخصيص غير مدعوم'
    ,invalid_message_template:'بيانات قالب الرسالة غير صالحة'
    ,invalid_template_channel:'قناة قالب الرسالة غير صالحة'
    ,message_template_not_found:'قالب الرسالة غير موجود'
    ,message_template_key_locked:'لا يمكن تغيير مفتاح قالب نظامي'
    ,integration_test_not_authorized:'ليس لديك صلاحية لاختبار هذا الربط'
    ,invalid_automation_action:'إجراء الأتمتة غير صالح'
    ,invalid_automation_rule:'معرّف قاعدة الأتمتة غير صالح'
    ,automation_rule_not_found:'قاعدة الأتمتة غير موجودة'
    ,invalid_automation_mode:'وضع التنفيذ غير صالح'
    ,invalid_automation_channel:'قناة الأتمتة غير صالحة'
    ,invalid_automation_fallback:'القناة البديلة غير صالحة'
    ,invalid_delivery_action:'إجراء إثبات التسليم غير صالح'
    ,delivery_webhook_not_found:'إعداد Webhook غير موجود'
    ,invalid_delivery_payload:'بيانات إشعار التسليم غير صالحة'
    ,invalid_delivery_state:'حالة التسليم غير صالحة'
    ,addon_not_enabled:'هذه الإضافة غير مفعلة'
    ,addon_access_check_failed:'تعذر التحقق من ترخيص الإضافة حاليًا'
    ,addon_product_not_found:'الإضافة المطلوبة غير موجودة'
    ,addon_already_enabled:'الإضافة مفعّلة بالفعل ضمن باقتك'
    ,addon_trial_unavailable:'التجربة غير متاحة لهذه الإضافة'
    ,addon_request_not_found:'طلب الإضافة غير موجود'
    ,invalid_addon_action:'إجراء الإضافة غير صالح'
    ,invalid_addon_subscription:'معرّف اشتراك الإضافة غير صالح'
    ,addon_subscription_not_found:'اشتراك الإضافة غير موجود'
    ,addon_usage_limit_reached:'وصلت الإضافة إلى حد الاستخدام الحالي'
    ,marketplace_product_invalid:'بيانات المنتج غير صالحة'
    ,marketplace_product_not_found:'المنتج غير متاح للشراء حاليًا'
    ,marketplace_idempotency_required:'تعذر تأمين طلب الشراء؛ أعد المحاولة'
    ,marketplace_idempotency_conflict:'مفتاح إعادة المحاولة مستخدم لطلب آخر؛ ابدأ طلبًا جديدًا'
    ,marketplace_quantity_invalid:'الكمية المختارة غير صالحة'
    ,marketplace_order_invalid:'رقم الطلب غير صالح'
    ,marketplace_order_not_found:'طلب الشراء غير موجود'
    ,marketplace_order_not_cancellable:'لا يمكن إلغاء الطلب بعد تأكيد الدفع'
    ,marketplace_order_not_payable:'هذا الطلب لا يقبل الدفع في حالته الحالية'
    ,marketplace_payment_provider_mismatch:'وسيلة الدفع لا تطابق الطلب'
    ,marketplace_payment_provider_unavailable:'وسيلة الدفع غير متاحة حاليًا'
    ,paymob_order_cancel_requires_payment_resolution:'لا يمكن إلغاء طلب Paymob قبل حسم حالة عملية الدفع؛ تابع نفس العملية أو تواصل مع الدعم'
    ,marketplace_action_invalid:'إجراء المتجر غير مدعوم'
    ,bank_transfer_reference_required:'أدخل مرجع التحويل البنكي'
    ,bank_transfer_sender_required:'أدخل اسم المحوّل'
    ,bank_transfer_date_invalid:'تاريخ التحويل غير صالح'
    ,bank_transfer_already_approved:'تم اعتماد هذا التحويل بالفعل'
    ,service_marketplace_action_invalid:'إجراء متجر الخدمات غير مدعوم'
    ,service_package_invalid:'باقة الخدمة المختارة غير صالحة'
    ,service_package_not_found:'باقة الخدمة لم تعد متاحة'
    ,service_quote_required:'هذه الخدمة تحتاج طلب عرض سعر قبل الشراء'
    ,service_brief_invalid:'تفاصيل طلب الخدمة غير صالحة أو أطول من المسموح'
    ,service_review_invalid:'يمكن تقييم طلب خدمة مكتمل فقط وبدرجة من 1 إلى 5'
    ,service_review_unavailable:'لا يمكن إضافة تقييم لهذا الطلب حاليًا'
    ,integration_configuration_missing:'إعدادات المزود غير مكتملة'
    ,whatsapp_credentials_missing:'بيانات Meta WhatsApp غير مكتملة'
    ,resend_configuration_missing:'بيانات Resend غير مكتملة'
    ,amazon_ses_sender_missing:'حدد بريد إرسال موثّق في Amazon SES'
    ,amazon_ses_not_configured:'بيانات Amazon SES غير مكتملة'
    ,webhook_url_invalid:'رابط API غير صالح'
    ,webhook_https_public_url_required:'يجب استخدام رابط HTTPS عام وآمن'
    ,session_not_schedulable:'لا يمكن إنشاء اجتماع لجلسة غير مجدولة'
    ,zoom_requires_online_session:'اجتماع Zoom متاح للجلسة عن بُعد أو الهجينة فقط'
    ,zoom_session_must_be_future:'لا يمكن إنشاء اجتماع Zoom لجلسة انتهى موعدها'
    ,invalid_attendance_threshold:'نسبة الحضور المطلوبة يجب أن تكون من 0 إلى 100'
    ,invalid_assessment_threshold:'نسبة التقييم المطلوبة يجب أن تكون من 0 إلى 100'
    ,certificate_not_eligible:'لا يمكن إصدار الشهادة قبل استكمال شروط الحضور والتقييم وإغلاق الدفعة'
    ,certificate_not_found:'الشهادة غير موجودة'
    ,revocation_reason_required:'اكتب سبب إلغاء الشهادة بوضوح'
    ,documents_incomplete:'استكمل المستندات المطلوبة قبل إتمام التسجيل'
    ,reason_required:'يجب كتابة السبب بوضوح'
    ,invalid_document_type:'نوع المستند غير صالح'
    ,invalid_document_status:'حالة المستند غير صالحة'
    ,due_at_required:'موعد المهمة مطلوب'
    ,opportunity_not_found:'الفرصة غير موجودة'
    ,task_not_found:'المهمة غير موجودة'
    ,empty_lead_import:'ملف العملاء لا يحتوي على صفوف قابلة للقراءة'
    ,lead_import_too_large:'الملف أكبر من الحد المسموح؛ الحد الأقصى 5000 صف'
    ,invalid_sales_channel:'نوع فريق المبيعات غير صالح'
    ,invalid_daily_capacity:'الطاقة اليومية يجب أن تكون بين 1 و1000 عميل'
    ,invalid_distribution_weight:'وزن التوزيع يجب أن يكون بين 1 و10'
    ,invalid_sales_assignee:'مسؤول المبيعات المختار غير صالح'
    ,lead_batch_not_found:'دفعة الرفع غير موجودة'
    ,lead_batch_already_distributed:'لا يمكن إلغاء دفعة بدأ توزيعها'
    ,invalid_distribution_strategy:'طريقة التوزيع غير صالحة'
    ,invalid_distribution_deadline:'حدد موعد متابعة قادمًا'
    ,distribution_deadline_too_far:'موعد المتابعة لا يمكن أن يتجاوز 90 يومًا'
    ,distribution_staff_required:'اختر مسؤول مبيعات واحدًا على الأقل'
    ,lead_batch_not_ready:'الدفعة غير جاهزة للتوزيع'
    ,no_online_sales_team:'لا يوجد مسؤول مبيعات أونلاين متاح للتوزيع'
    ,no_sales_team:'لا يوجد مسؤول مبيعات متاح ضمن الإعدادات الحالية'
    ,lead_assignment_required:'حدد عميلًا واحدًا على الأقل لتغيير الإسناد'
    ,lead_reassignment_too_large:'يمكن تغيير إسناد 100 عميل كحد أقصى في العملية الواحدة'
    ,invalid_lead_reassignment_payload:'بيانات تغيير الإسناد غير صالحة'
    ,lead_reassignment_reason_required:'اكتب سبب تغيير الإسناد بوضوح'
    ,lead_reassignment_reason_too_long:'سبب تغيير الإسناد أطول من الحد المسموح'
    ,lead_assignment_not_active:'تغيرت حالة أحد الإسنادات؛ حدّث الصفحة ثم أعد المحاولة'
    ,same_sales_assignee:'العملاء المحددون مسندون بالفعل إلى هذا المسؤول'
    ,invalid_lead_intake_action:'إجراء استقبال العملاء غير صالح'
  };
  return messages[String(value)]||String(value);
}
