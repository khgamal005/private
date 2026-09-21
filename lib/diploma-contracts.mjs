export const DIPLOMA_ACTIONS = Object.freeze(['create', 'revise_draft', 'approve', 'reschedule', 'link_invoice', 'waive_first_installment', 'classify_program', 'refresh_collection', 'resolve_settlement', 'set_collection_automation']);

export function monthlyInstallments(totalMinor, count, startsOn, makeId = () => crypto.randomUUID()) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1 || !Number.isInteger(count) || count < 1 || count > 30 || totalMinor < count || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw new Error('invalid_schedule');
  const [year, month, day] = startsOn.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.toISOString().slice(0, 10) !== startsOn) throw new Error('invalid_schedule');
  return Array.from({length: count}, (_, index) => {
    const target = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return {id: makeId(), dueOn: target.toISOString().slice(0, 10), amountMinor: Math.floor(totalMinor / count) + (index < totalMinor % count ? 1 : 0)};
  });
}

export function diplomaError(code) {
  return ({forbidden: 'ليست لديك الصلاحية المطلوبة.', authentication_required: 'انتهت الجلسة. سجّل الدخول مرة أخرى.',
    diploma_disabled: 'عقود الدبلومات لم تُفعّل لهذه المنشأة بعد.', diploma_changed: 'تغير العقد منذ فتحه. حدّث الصفحة.',
    diploma_program_required: 'صنّف البرنامج كدبلوم أولًا.', diploma_schedule_invalid: 'راجع تواريخ الأقساط ومجموعها؛ الحد الأقصى 30 شهرًا.',
    diploma_invoice_invalid: 'اختر فاتورة صادرة بنفس الدافع والعملة وقيمة القسط، وغير مرتبطة بعقد آخر.',
    diploma_linked_installment_required: 'احتفظ بمعرّف ومبلغ كل قسط مرتبط بفاتورة عند إعادة الجدولة.',
    diploma_approval_required: 'يجب اعتماد العقد أولًا.', diploma_reason_required: 'أدخل سببًا واضحًا من ثلاثة أحرف على الأقل.',
    diploma_scheduler_unavailable: 'جدولة المتابعة التلقائية غير جاهزة بعد.', diploma_outstanding_balance: 'لا يمكن إغلاق العقد مع مديونية على الفواتير الصادرة. راجع الحسابات أولًا.',
    diploma_settlement_review_required: 'العقد ليس في مرحلة مراجعة التسوية.',
    diploma_first_installment_immutable: 'لا يمكن تغيير القسط الأول المعتمد؛ راجع المالية لإجراء التسوية.',
    diploma_handoff_in_use: 'يوجد عقد لهذا التسجيل بالفعل.', diploma_program_in_use: 'لا يمكن تغيير نوع برنامج له عقد دبلوم.',
    command_id_reused_with_different_payload: 'تعارض مفتاح العملية. حدّث الصفحة وأعد المحاولة.'})[code] || 'تعذر حفظ العقد. راجع البيانات وحدّث الصفحة.';
}
