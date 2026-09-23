export const PUBLIC_STORE_ACTIONS=new Set(['create_order','view_order','report_transfer']);
export const PRIVATE_STORE_ACTIONS=new Set(['snapshot','save_settings','save_offer','publish_offer','verify_order','reject_order','reconcile_order']);
const messages={
 academy_delivery_disabled:'يجري تجهيز ربط الدورات والملفات لهذه المنشأة.',
 academy_installments_invalid:'راجع خطة التقسيط: القسط الأول عند التسجيل، والمجموع يساوي الإجمالي شامل الضريبة.',
 academy_installments_unavailable:'التقسيط غير متاح لهذا العرض. اختر السداد الكامل.',
 academy_member_role_conflict:'الحساب مرتبط بدور إداري حالي. راجع صلاحياته من إدارة الفريق قبل دعوته كمحاضر.',
 training_student_already_linked:'حساب الطالب مرتبط بالفعل. يستخدم حسابه الحالي للدخول.',
 academy_free_order_no_transfer:'هذه دورة مجانية ولا تحتاج بلاغ تحويل.',
 academy_store_unavailable:'المتجر غير متاح لهذه المنشأة.',academy_checkout_disabled:'استقبال الطلبات متوقف مؤقتًا.',
 academy_short_course_required:'هذا المتجر يقبل الدورات القصيرة المصنفة. تحتاج الدبلومات إلى مسار العقود الخاص بها.',
 academy_offer_unavailable:'هذا العرض غير متاح للتسجيل الآن.',academy_learning_not_published:'انشر محتوى الدورة المعتمد قبل عرضها للبيع.',
 academy_finance_setup_required:'أكمل إعداد العملة والضريبة أولًا. للمنشأة المرتبطة بأودير يتم ذلك من إعدادات الحسابات.',
 academy_identity_required:'أدخل اسمًا ورقم جوال وبريدًا إلكترونيًا صحيحًا للمتدرب والدافع.',
 academy_identity_review_required:'رقم الهاتف مرتبط بملف قائم ببريد مختلف. راجع هوية صاحبه وملفه قبل اعتماد الطلب؛ لم تتغير بياناته.',
 academy_identity_confirmation_required:'أكد التحقق من هوية المتدرب والدافع واستلام التحويل قبل اعتماد الطلب.',
 academy_received_amount_mismatch:'المبلغ المستلم يجب أن يطابق المطلوب الآن: إجمالي الطلب أو القسط الأول في الخطة المعتمدة.',
 academy_payment_reference_required:'أدخل مرجعًا واضحًا للتحويل البنكي (4 أحرف على الأقل).',
 academy_order_not_found:'رابط متابعة الطلب غير صالح أو غير متاح.',academy_order_not_editable:'تغيرت حالة الطلب. حدّث البيانات.',
 academy_rate_limited:'بلغ عدد الطلبات الحد المؤقت. حاول لاحقًا أو تواصل مع المنشأة.',
 academy_cohort_schedule_required:'حدد بداية الدفعة ونهايتها وسعتها.',academy_learner_blocked:'ملف المتدرب موقوف ويحتاج مراجعة.',
 academy_payer_account_blocked:'الحساب المالي للدافع موقوف ويحتاج مراجعة.',
 already_registered:'المتدرب مسجل بالفعل في هذه الدفعة. راجع الطلب دون تسجيل مبلغ جديد.',
 course_run_full:'اكتملت سعة الدفعة. لم يتم اعتماد التحويل؛ راجع الطلب مع المتدرب.',
 course_run_not_open:'الدفعة غير متاحة للتسجيل الآن. لم يتم اعتماد الطلب.',
 invalid_payment_date:'أدخل تاريخ الاستلام الفعلي؛ لا يمكن أن يكون في المستقبل.',
 command_conflict:'تغيرت بيانات العملية. حدّث الصفحة وأعد المحاولة.',forbidden:'ليست لديك صلاحية لهذا الإجراء.',
 training_journey_disabled:'فعّل تشغيل التدريب قبل اعتماد التسجيلات.',
};
export function academyCommerceError(code){
 if(messages[code])return messages[code];
 if(/unique|duplicate/.test(code||''))return 'يوجد تسجيل أو مرجع تحويل مسجل بالفعل. راجع البيانات قبل إعادة المحاولة.';
 if(/permission|forbidden/.test(code||''))return messages.forbidden;
 if(/not_found|invalid|required|check|violat/.test(code||''))return 'راجع الحقول المطلوبة والقيم المدخلة وأعد المحاولة.';
 return 'تعذر إتمام العملية. أعد المحاولة بنفس البيانات لتجنب التكرار.';
}
