'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

export const ADMISSION_WAITING_LABELS={
 beneficiary_phone_required:'بانتظار رقم جوال مستقل للمستفيد',course_required:'بانتظار تحديد البرنامج',
 program_classification_required:'بانتظار تصنيف البرنامج: دورة قصيرة أو دبلوم',required_documents_incomplete:'بانتظار اعتماد المستندات المطلوبة',
 agreed_price_required:'بانتظار توثيق القيمة المتفق عليها',full_payment_required:'بانتظار استكمال سداد الدورة',
 first_installment_required:'بانتظار الدفعة الأولى للدبلوم',diploma_contract_required:'بانتظار عقد الدبلوم',
 course_run_required:'مؤكد ماليًا وبانتظار التسكين',course_run_unavailable:'الدفعة انتهت أو ألغيت؛ يلزم اختيار دفعة أو تسوية',
 planned_run_reservation:'حجز على دفعة تحت الإعداد',late_enrollment_approval_required:'بانتظار اعتماد التسجيل المتأخر',
 registration_window_closed:'بانتظار فتح موعد التسجيل',course_run_full:'بانتظار مقعد متاح',
 beneficiary_placement_required:'بانتظار تسكين المستفيدين',payment_source_review_required:'بانتظار مراجعة مصدر الدفع',
 existing_student_run_review_required:'يوجد تسجيل سابق لنفس المتدرب والدفعة؛ يلزم مراجعته',
 payment_currency_mismatch:'عملة الدفعة لا تطابق الاتفاق المالي',student_profile_blocked:'ملف المتدرب موقوف؛ يلزم مراجعة مخولة',
 beneficiary_enrollment_review_required:'يوجد تسجيل مستفيد ملغى أو منسحب؛ يلزم مراجعته',
 approved_diploma_contract_required:'بانتظار عقد دبلوم معتمد',diploma_disabled:'يلزم تفعيل سياسة الدبلومات',
 commercial_terms_invoice_mismatch:'الاتفاق لا يطابق الفاتورة؛ يلزم تعديل مالي موثق',
 issued_invoice_required:'بانتظار إصدار الفاتورة المرتبطة',refund_invoice_allocation_required:'يلزم تحديد الفاتورة المتأثرة بالاسترداد'
};

export function AdmissionReadiness({readiness,timezone}){
 if(!readiness)return null;
 const label=readiness.state==='enrolled'?'تم التسجيل أكاديميًا':readiness.state==='ready'?'جاهز للتسجيل':
  ADMISSION_WAITING_LABELS[readiness.waitingReason]||'قيد مراجعة متطلبات التسجيل';
 return <div className="mt-alert"><b>{label}</b>{readiness.reviewAt&&<small> · المراجعة التالية: {new Date(readiness.reviewAt).toLocaleString('ar-SA',{timeZone:timezone||'Asia/Riyadh'})}</small>}</div>;
}

export default function AdmissionGovernancePanel({slug,policy}){
 const router=useRouter();
 const [draft,setDraft]=useState(()=>({...policy}));
 const [preview,setPreview]=useState(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 if(!policy?.canManage)return null;
 function change(key,value){setDraft(current=>({...current,[key]:value}));setPreview(null);}
 async function save(action){
  setBusy(true);setError('');
  try{
   const payload={enabled:Boolean(draft.enabled),financeBusinessDays:Number(draft.financeBusinessDays||1),
    placementBusinessDays:Number(draft.placementBusinessDays||1),weekendIsoDays:draft.weekendIsoDays||[5,6],
    financeOwnerStaffId:draft.financeOwnerStaffId||null,placementOwnerStaffId:draft.placementOwnerStaffId||null};
   if(action==='save_policy'){payload.previewToken=preview.previewToken;payload.confirmed=true;}
   const response=await fetch('/api/tenant/admission-governance',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({p_tenant_slug:slug,p_action:action,p_payload:payload})});
   const body=await response.json();if(!response.ok)throw new Error(body.error||'تعذر حفظ سياسة التسجيل');
   if(action==='preview_policy')setPreview(body.data);else{setPreview(null);router.refresh();}
  }catch(err){setError(err.message);}finally{setBusy(false);}
 }
 const weekdays=[[1,'الاثنين'],[2,'الثلاثاء'],[3,'الأربعاء'],[4,'الخميس'],[5,'الجمعة'],[6,'السبت'],[7,'الأحد']];
 return <details className="mt-panel"><summary>سياسة التسجيل والتسكين · {policy.enabled?'مفعلة':'غير مفعلة'}</summary>
  <p>تسجيل تلقائي بعد استكمال المتطلبات. حالات الانتظار لها مسؤول وموعد مراجعة. الأقساط والحالة الدراسية مستقلان.</p>
  <div className="mt-form">
   <label className="mt-field">تفعيل السياسة<input type="checkbox" checked={Boolean(draft.enabled)} onChange={e=>change('enabled',e.target.checked)}/></label>
   <label className="mt-field">مهلة مراجعة المالية — أيام عمل<input type="number" min="1" max="30" value={draft.financeBusinessDays||1} onChange={e=>change('financeBusinessDays',e.target.value)}/></label>
   <label className="mt-field">مهلة التسكين — أيام عمل<input type="number" min="1" max="30" value={draft.placementBusinessDays||1} onChange={e=>change('placementBusinessDays',e.target.value)}/></label>
   {[["financeOwnerStaffId","مسؤول مراجعة المالية"],["placementOwnerStaffId","مسؤول التسكين"]].map(([key,label])=><label className="mt-field" key={key}>{label}<select value={draft[key]||''} onChange={e=>change(key,e.target.value)}><option value="">اختر المسؤول</option>{(policy.staff||[]).map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>)}
  </div>
  <fieldset><legend>أيام العطلة الأسبوعية</legend>{weekdays.map(([day,label])=><label key={day}><input type="checkbox" checked={(draft.weekendIsoDays||[]).includes(day)} onChange={e=>change('weekendIsoDays',e.target.checked?[...(draft.weekendIsoDays||[]),day]:(draft.weekendIsoDays||[]).filter(x=>x!==day))}/>{label} </label>)}</fieldset>
  <p>طلبات إعادة التقييم: {policy.queueCount||0} · تحتاج معالجة: {policy.failedCount||0}</p>
  {error&&<div className="mt-alert error">{error}</div>}
  <button type="button" className="mt-button soft" disabled={busy} onClick={()=>save('preview_policy')}>معاينة الأثر</button>
  {preview&&<div className="mt-alert"><p>{preview.impact.openAdmissions} طلبًا مفتوحًا · {preview.impact.readyToEnroll||0} مستوفٍ للتسجيل الآن · {preview.impact.unclassifiedPrograms} برنامجًا يحتاج التصنيف · {preview.impact.withoutRun} طلبًا بلا دفعة.</p>
   <p>عند التفعيل تُعاد مراجعة هذه الطلبات؛ المستوفي للمتطلبات يُسجل تلقائيًا.</p>
   <button type="button" className="mt-button primary" disabled={busy} onClick={()=>save('save_policy')}>تأكيد وحفظ السياسة المعروضة</button>
  </div>}
 </details>;
}
