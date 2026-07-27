import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const RPC={
  'create-staff':'v2_tenant_create_staff',
  'update-staff':'v2_tenant_update_staff',
  'invite-staff':'v2_tenant_invite_staff',
  'create-course':'v2_tenant_create_course',
  'create-contact':'v2_tenant_create_contact',
  'create-sales-lead':'v2_tenant_create_sales_lead',
  'record-sales-followup':'v2_tenant_record_sales_followup_v2',
  'update-admission':'v2_tenant_update_admission',
  'update-admission-document':'v2_tenant_update_admission_document',
  'save-course-run':'v2_tenant_save_course_run',
  'update-training-operation':'v2_tenant_update_training_operation',
  'training-automation':'v2_tenant_training_automation_action',
  'create-opportunity':'v2_tenant_create_opportunity',
  'move-opportunity':'v2_tenant_move_opportunity',
  'log-activity':'v2_tenant_log_activity',
  'create-task':'v2_tenant_create_task',
  'update-task-status':'v2_tenant_update_task_status'
};

export async function POST(request,{params}){
  try{
    const {action}=await params;
    const rpc=RPC[action];
    if(!rpc){
      return NextResponse.json({error:'عملية غير مدعومة'},{status:404});
    }

    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return NextResponse.json({error:'انتهت الجلسة'},{status:401});
    }

    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(await request.json()),
      cache:'no-store'
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      return NextResponse.json({
        error:translate(data?.message||data?.detail||'تعذر تنفيذ العملية'),
        detail:data
      },{status:response.status});
    }

    return NextResponse.json({success:true,data});
  }catch(error){
    return NextResponse.json({
      error:'تعذر تنفيذ العملية',
      detail:error.message
    },{status:500});
  }
}

function translate(value){
  const messages={
    forbidden:'ليس لديك صلاحية لتنفيذ العملية',
    tenant_not_found:'المنشأة غير موجودة',
    full_name_required:'اسم الموظف مطلوب',
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
  };
  return messages[String(value)]||String(value);
}
