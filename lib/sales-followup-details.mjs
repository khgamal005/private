import {normalizeCustomerPhoneIdentity} from './customer-phone.mjs';

export const MAX_INTERESTS=20;
export const MAX_ADDITIONAL_PHONES=4;

export function availableAdditionalPhoneSlots(primaryPhone,whatsapp){
  const primary=normalizeCustomerPhoneIdentity(primaryPhone);
  const alternate=normalizeCustomerPhoneIdentity(whatsapp);
  return MAX_ADDITIONAL_PHONES-(alternate&&alternate!==primary?1:0);
}

export function serializeFollowupDetails(details){
  if(!details?.revision)throw new Error('انتظر تحميل بيانات العميل قبل الحفظ.');
  if(!normalizeCustomerPhoneIdentity(details.primaryPhone))throw new Error('أكمل رقم الجوال الأساسي من تعديل بيانات العميل أولًا.');
  const courseInterests=details.rows.filter(row=>row.courseId).map(row=>({
    courseId:row.courseId,courseRunId:row.courseRunId||null,
    attendanceSessionId:row.attendanceSessionId||null
  }));
  if(courseInterests.length>MAX_INTERESTS)throw new Error('يمكن اختيار ٢٠ دورة كحد أقصى.');
  if(new Set(courseInterests.map(row=>row.courseId)).size!==courseInterests.length){
    throw new Error('الدورة مضافة بالفعل؛ اختر دورة أخرى.');
  }
  const additionalPhones=details.phones.map(row=>row.value.trim()).filter(Boolean);
  if(additionalPhones.length>availableAdditionalPhoneSlots(details.primaryPhone,details.whatsapp)){
    throw new Error('يمكن إضافة ٤ أرقام بجانب الجوال الأساسي؛ رقم واتساب المختلف يُحتسب ضمنها.');
  }
  const seen=new Set([details.primaryPhone,details.whatsapp].map(normalizeCustomerPhoneIdentity).filter(Boolean));
  for(const phone of additionalPhones){
    const identity=normalizeCustomerPhoneIdentity(phone);
    if(!identity||phone.length>40)throw new Error('راجع الرقم الإضافي؛ استخدم رقمًا صحيحًا مع رمز الدولة عند الحاجة.');
    if(seen.has(identity))throw new Error('الرقم مضاف بالفعل ضمن أرقام العميل.');
    seen.add(identity);
  }
  return {courseInterests,additionalPhones};
}

export function attendanceLabel(value,timezone='Asia/Riyadh'){
  if(!value)return 'الموعد لم يحدد بعد';
  return new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',dateStyle:'medium',timeStyle:'short',timeZone:timezone||'Asia/Riyadh'}).format(new Date(value));
}

export async function requestFollowupDetails(action,body,signal){
  const response=await fetch(`/api/tenant/${action}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal
  });
  const payload=await response.json();
  if(!response.ok)throw new Error(payload.error||'تعذر تحميل بيانات المتابعة');
  return payload.data;
}

export function interestCourseNames(contact){
  return contact?.followupDetails?.courseInterests?.map(item=>item.courseName).filter(Boolean).join(' · ')||contact?.interestCourseName||'';
}

export function unscheduledOpportunityCount(contact){
  return (contact?.followupDetails?.openOpportunities||[]).filter(item=>!item.nextActionAt).length;
}
