import {WOO_BENEFICIARY_ERRORS} from './woocommerce-beneficiaries.mjs';

export const WOO_ADMISSION_ERRORS=Object.freeze({
  woocommerce_items_missing:'بنود الطلب غير مكتملة. راجع مزامنة المتجر.',
  woocommerce_payment_unconfirmed:'الطلب غير مدفوع أو حالته لا تسمح بتأكيد الدفع.',
  woocommerce_payment_date_missing:'تاريخ الدفع الفعلي غير متاح من المتجر. يلزم التحقق منه.',
  woocommerce_refund_review:'يوجد استرداد على الطلب. يلزم مراجعته قبل التسجيل.',
  woocommerce_currency_or_amount:'هذا المسار يدعم حاليًا الطلبات المدفوعة بالريال السعودي بمبلغ موجب.',
  woocommerce_customer_required:'اربط الطلب بعميل صحيح أولًا.',
  woocommerce_assignment_required:'يجب أن يسند مدير المبيعات الطلب إلى موظف أولًا.',
  woocommerce_owner_transfer_required:'يلزم اعتماد نقل ملكية العميل إلى الموظف المسند إليه الطلب بواسطة مدير المبيعات.',
  woocommerce_owner_conflict:'طلبات نفس العميل يجب إسنادها لنفس المسؤول. استخدم الإسناد اليدوي للمحدد.',
  woocommerce_choose_all_courses:'افتح طلب WooCommerce وحدد دورة لكل بند ثم اختر «إتمام وإرسال للتسجيل».',
  woocommerce_order_changed:'تغير الطلب أو التسجيلات المرتبطة. حدّث البيانات وراجعها قبل الحفظ.',
  woocommerce_review_required:'يلزم أن يراجع المدير ارتباط الطلب بالتسجيلات السابقة أولًا.',
  woocommerce_review_reason_required:'اكتب نتيجة مراجعة التسجيلات السابقة وسبب إنشاء تسجيل جديد أو ربط تسجيل موجود.',
  woocommerce_review_changed:'تغير اختيار الدورة أو التسجيل المعتمد. اطلب مراجعة جديدة.',
  woocommerce_duplicate_handoff:'هذا التسجيل مرتبط ببند آخر بالفعل؛ لا يمكن احتساب نفس الدفع مرتين.',
  woocommerce_existing_payment_unlinked:'يوجد بلاغ دفع مؤكد يحمل رقم هذا الطلب. يجب مراجعته وربطه قبل إنشاء تسجيل جديد.',
  woocommerce_invalid_existing_admission:'التسجيل المختار غير صالح للربط بهذا العميل والطلب.',
  woocommerce_existing_payment_mismatch:'مبلغ البلاغ السابق أو دورته لا يطابق البند. يلزم تصحيح موثّق قبل الربط؛ لم تتغير البيانات.',
  woocommerce_settled_incentive_review:'البيع مرتبط بحافز معتمد أو مصروف للموظف السابق. تلزم مراجعة مالية لنقل الاحتساب.',
  woocommerce_command_conflict:'طلب الحفظ مكرر ببيانات مختلفة. حدّث الشاشة.',
  woocommerce_already_submitted:'تم إرسال هذا الطلب للتسجيل بالفعل. حدّث البيانات لعرض النتيجة.',
  woocommerce_admissions_disabled:'المسار الجديد غير مفعل لهذه المنشأة بعد.',
  woocommerce_admissions_staff_required:'يلزم وجود موظف نشط للتسجيل والقبول قبل الإرسال.',
  woocommerce_allocation_mismatch:'تعذر مطابقة توزيع المبلغ مع إجمالي الطلب.',
  woocommerce_course_locked:'الدورة مرتبطة ببند شراء معتمد؛ اختر دفعتها من التسجيل والقبول.',
  woocommerce_payment_changed:'تغير الدفع أو بنود الطلب في المتجر. أوقف التسجيل لحين مراجعة المصدر.',
  ...WOO_BENEFICIARY_ERRORS
});

export function initialWooSelections(context){
  if(context.reviewValid&&context.reviewLines)return context.reviewLines;
  return (context.items||[]).map(item=>{
    const matches=(context.candidates||[]).filter(h=>!h.linked&&h.amountMinor===item.amountMinor
      &&[context.orderNumber,`WooCommerce #${context.orderNumber}`].includes(h.reference)
      &&(!item.suggestedCourseId||h.courseId===item.suggestedCourseId));
    const match=matches.length===1?matches[0]:null;
    return {lineId:item.lineId,courseId:match?.courseId||item.suggestedCourseId||'',handoffId:match?.id||null};
  });
}
