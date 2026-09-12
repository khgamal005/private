export const WOO_BENEFICIARY_ERRORS=Object.freeze({
  woocommerce_beneficiaries_required:'حدد مستفيدًا لكل مقعد ثم اضغط «حفظ المستفيدين».',
  woocommerce_beneficiaries_invalid:'راجع المستفيدين والدورات؛ يجب تحديد اسم مختلف لكل مقعد في البند نفسه.',
  woocommerce_beneficiaries_limit:'يدعم الطلب حتى 100 مقعد بأعداد صحيحة. راجع كمية الطلب في المتجر.',
  woocommerce_beneficiaries_locked:'أُرسل الطلب للتسجيل بالفعل؛ لا يمكن تغيير مستفيد مسجل من هذه النافذة.',
  woocommerce_beneficiary_identity_required:'أدخل اسم المستفيد ورقم جوال سعودي صحيح مثل 05xxxxxxxx.',
  woocommerce_beneficiary_duplicate:'لا يمكن اختيار نفس المستفيد مرتين في البند نفسه.',
  woocommerce_beneficiary_exists:'هذا الجوال مسجل بالفعل. اختر «عميل موجود» وابحث عنه؛ وقد تحتاج مراجعة المدير لصلاحية الوصول.',
  woocommerce_beneficiary_contact_unavailable:'المستفيد غير متاح ضمن صلاحياتك. اطلب من مدير المبيعات مراجعة الاختيار.',
  woocommerce_existing_beneficiary_mismatch:'التسجيل السابق يتضمن متدربًا غير موجود في قائمة المستفيدين. راجع القائمة دون إنشاء تسجيل بديل له.',
  woocommerce_existing_enrollment_review:'التسجيل السابق ملغي أو منسحب. يلزم مراجعته قبل ربط مقاعد جديدة؛ لم تتغير البيانات.',
  woocommerce_use_beneficiary_registration:'اختر الدفعات من قسم «تسجيل المستفيدين» لإتمام كل مقعد دون تكرار الدفع.',
  woocommerce_beneficiary_blocked:'ملف أحد المستفيدين موقوف؛ يلزم مراجعة التسجيل والقبول.',
  woocommerce_beneficiary_already_enrolled:'أحد المستفيدين مسجل بالفعل في هذه الدفعة. راجع التسجيل السابق قبل المتابعة.',
  woocommerce_order_changed:'تغيرت بيانات الطلب. حدّث النافذة وراجع أحدث البيانات قبل الحفظ.',
  woocommerce_payment_changed:'تغير الدفع في المتجر؛ يلزم مراجعته قبل استكمال التسجيل.',
  woocommerce_review_changed:'تم اعتماد هذه الاختيارات؛ اطلب من المدير مراجعتها قبل تغيير المستفيدين.',
  woocommerce_command_conflict:'تعارضت محاولة الحفظ مع طلب سابق. حدّث النافذة.',
  woocommerce_admissions_disabled:'مسار التسجيل من المتجر غير مفعل لهذه المنشأة.',
  course_run_full:'المقاعد المتاحة في إحدى الدفعات لا تكفي للمستفيدين المحددين. لم يُسجل أي منهم في هذه المحاولة.',
  course_run_registration_closed:'التسجيل في إحدى الدفعات لم يفتح أو انتهى. اختر دفعة متاحة.',
  invalid_course_run:'اختر دفعة متاحة تابعة للدورة نفسها.',
  payment_not_verified:'يلزم تأكيد الدفع قبل تسجيل المستفيدين.',
  documents_incomplete:'استكمل المستندات المطلوبة قبل إتمام التسجيل.',
  admission_not_found:'طلب التسجيل غير موجود أو غير متاح.',
  forbidden:'ليس لديك صلاحية لتنفيذ العملية.',
  task_closed:'المهمة مغلقة؛ حدّث البيانات.'
});

export function normalizeBeneficiaryPhone(value=''){
  let phone=String(value).replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?1632:1776)))
    .replace(/[\s()+.\-]/g,'');
  if(/^009665\d{8}$/.test(phone))phone=`0${phone.slice(5)}`;
  else if(/^9665\d{8}$/.test(phone))phone=`0${phone.slice(3)}`;
  return /^05\d{8}$/.test(phone)?phone:'';
}

export function initialBeneficiaryLines(context){
  const quantities=(context.items||[]).map(item=>Number(item.quantity));
  const bounded=quantities.every(q=>Number.isInteger(q)&&q>0)&&quantities.reduce((sum,q)=>sum+q,0)<=100;
  return (context.items||[]).map(item=>({lineId:item.lineId,title:item.title,quantity:Number(item.quantity),
    beneficiaries:Array.from({length:bounded&&Number.isInteger(Number(item.quantity))&&Number(item.quantity)>0&&Number(item.quantity)<=100?Number(item.quantity):0},(_,index)=>{
      const saved=(context.beneficiaries||[]).find(b=>b.lineId===item.lineId&&b.seatNumber===index+1);
      // An ordinary one-seat line retains its original buyer default. Group seats
      // are deliberately blank: purchasing is not evidence of attendance.
      const buyer=!saved&&Number(item.quantity)===1&&context.contactId;
      return {mode:'existing',contactId:saved?.contactId||(buyer?context.contactId:''),
        name:saved?.name||(buyer?context.contactName:''),phone:saved?.phone||''};
    })}));
}
export function beneficiaryPayload(lines){
  return lines.map(line=>({lineId:line.lineId,beneficiaries:line.beneficiaries.map(b=>
    b.mode==='new'?{name:b.name.trim(),phone:normalizeBeneficiaryPhone(b.phone)}:{contactId:b.contactId||null})}));
}
export function beneficiaryValidation(lines){
  const total=lines.reduce((sum,line)=>sum+line.quantity,0);
  if(!lines.length||!Number.isInteger(total)||total>100||total<1)return WOO_BENEFICIARY_ERRORS.woocommerce_beneficiaries_limit;
  for(const line of lines){
    if(!Number.isInteger(line.quantity)||line.quantity<1||line.beneficiaries.length!==line.quantity)return WOO_BENEFICIARY_ERRORS.woocommerce_beneficiaries_required;
    const seen=new Set();
    for(const b of line.beneficiaries){
      const identity=b.mode==='new'?normalizeBeneficiaryPhone(b.phone):b.contactId;
      if(!identity||(b.mode==='new'&&(b.name.trim().length<2||b.name.trim().length>150)))return WOO_BENEFICIARY_ERRORS.woocommerce_beneficiary_identity_required;
      const key=`${b.mode}:${identity}`;
      if(seen.has(key))return WOO_BENEFICIARY_ERRORS.woocommerce_beneficiary_duplicate;
      seen.add(key);
    }
  }
  return '';
}

export async function requestWooBeneficiaries(action,body,signal){
  const response=await fetch('/api/tenant/woocommerce-beneficiaries',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...body}),signal
  });
  let payload;
  try{payload=await response.json();}catch{throw new Error('تعذر الاتصال. أعد المحاولة بنفس البيانات للتحقق من نتيجة الحفظ.');}
  if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية. أعد المحاولة.');
  return payload.data;
}
