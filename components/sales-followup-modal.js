'use client';

import {useMemo,useState} from 'react';

const EMPTY=[];

export const OPEN_STATUSES=new Set([
  'new',
  'no_answer',
  'busy',
  'follow_up',
  'interested',
  'very_interested',
  'awaiting_payment',
  'postponed'
]);

export const STATUS={
  new:{label:'جديد',tone:'neutral'},
  no_answer:{label:'لم يرد',tone:'muted'},
  busy:{label:'مشغول',tone:'warning'},
  follow_up:{label:'متابعة لاحقة',tone:'info'},
  interested:{label:'مهتم',tone:'good'},
  very_interested:{label:'مهتم جدًا',tone:'excellent'},
  awaiting_payment:{label:'بانتظار الدفع',tone:'payment'},
  payment_submitted:{label:'أبلغ بالدفع',tone:'review'},
  paid:{label:'تم تأكيد الدفع',tone:'paid'},
  postponed:{label:'مؤجل',tone:'warning'},
  not_interested:{label:'غير مهتم',tone:'closed'},
  unqualified:{label:'غير مؤهل',tone:'closed'},
  wrong_number:{label:'رقم غير صحيح',tone:'closed'},
  duplicate:{label:'مكرر',tone:'closed'},
  cancelled:{label:'ملغي',tone:'closed'}
};

export const QUALITY={
  unrated:{label:'غير مقيم',tone:'muted',help:'لم يُقيّم بعد'},
  unqualified:{label:'غير مؤهل',tone:'closed',help:'لا تنطبق عليه شروط الدورة'},
  weak:{label:'ضعيف',tone:'warning',help:'بيانات ناقصة أو احتياج غير واضح'},
  qualified:{label:'مؤهل',tone:'info',help:'تنطبق عليه الشروط ولديه احتياج'},
  good:{label:'جيد',tone:'good',help:'مؤهل ومتفاعل ولديه نية زمنية'},
  excellent:{label:'ممتاز',tone:'excellent',help:'مؤهل وصاحب قرار ومستعد للتسجيل'}
};

export const ACTIONS={
  call:'اتصال',
  whatsapp:'واتساب',
  send_details:'إرسال التفاصيل',
  meeting:'اجتماع',
  payment_followup:'متابعة الدفع',
  follow_up:'متابعة عامة'
};

export function dateOnly(value){
  return value?new Date(value).toLocaleDateString('ar-SA',{
    day:'numeric',
    month:'short',
    year:'numeric'
  }):'لم يحدد';
}

export function SalesStatusBadge({value}){
  const meta=STATUS[value]||{label:value||'غير محدد',tone:'muted'};
  return <span className={`mt-lead-badge ${meta.tone}`}>{meta.label}</span>;
}

export function SalesQualityBadge({value}){
  const meta=QUALITY[value]||QUALITY.unrated;
  return <span className={`mt-quality-badge ${meta.tone}`}>{meta.label}</span>;
}

export function StatusSelect(props){
  return <select {...props}>
    {Object.entries(STATUS)
      .filter(([key])=>key!=='paid')
      .map(([key,item])=><option value={key} key={key}>{item.label}</option>)}
  </select>;
}

export function QualitySelect({defaultValue='unrated',...props}){
  return <div className="mt-quality-control">
    <select defaultValue={defaultValue||'unrated'} {...props}>
      {Object.entries(QUALITY).map(([key,item])=><option value={key} key={key}>{item.label}</option>)}
    </select>
    <small>غير مؤهل: لا تنطبق الشروط · مؤهل: تنطبق الشروط · ممتاز: مستعد للتسجيل</small>
  </div>;
}

export function ActionSelect({preferred='call',...props}){
  return <select defaultValue={preferred} {...props}>
    {Object.entries(ACTIONS).map(([key,label])=><option value={key} key={key}>{label}</option>)}
  </select>;
}

export default function SalesFollowupModal({
  slug,
  contact,
  courses=EMPTY,
  courseRuns=EMPTY,
  onClose,
  onSaved
}){
  const [followupStatus,setFollowupStatus]=useState(
    OPEN_STATUSES.has(contact?.leadStatus)?contact.leadStatus:'follow_up'
  );
  const [selectedCourseId,setSelectedCourseId]=useState(contact?.interestCourseId||'');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  const availableRuns=useMemo(()=>courseRuns.filter(run=>
    !selectedCourseId||run.courseId===selectedCourseId
  ),[courseRuns,selectedCourseId]);

  function close(){
    if(!busy)onClose();
  }

  async function submit(event){
    event.preventDefault();
    setBusy(true);
    setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const open=OPEN_STATUSES.has(values.lead_status);
    const paymentSubmitted=values.lead_status==='payment_submitted';

    try{
      const response=await fetch('/api/tenant/record-sales-followup',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_contact_id:contact.id,
          p_activity_type:values.activity_type,
          p_summary:values.summary,
          p_lead_status:values.lead_status,
          p_lead_quality:values.lead_quality,
          p_next_action_type:open?values.next_action_type:null,
          p_next_action_at:open?new Date(values.next_action_at).toISOString():null,
          p_course_id:values.course_id||null,
          p_course_run_id:paymentSubmitted?(values.course_run_id||null):null,
          p_payment_amount_minor:paymentSubmitted&&values.payment_amount
            ?Math.round(Number(values.payment_amount)*100)
            :null,
          p_payment_reference:paymentSubmitted?(values.payment_reference||null):null,
          p_preferred_start_date:paymentSubmitted?(values.preferred_start_date||null):null,
          p_closure_reason:!open&&!paymentSubmitted
            ?(values.closure_reason||null)
            :null
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر حفظ نتيجة المتابعة');
      const message=payload.data?.paymentReviewNotified
        ?'تم إرسال بلاغ الدفع إلى التسجيل والقبول للتحقق قبل التأكيد'
        :'تم حفظ النتيجة وإنشاء مهمة الإجراء التالي تلقائيًا';
      onSaved(message,payload.data);
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  return <div className="mt-modal-layer" dir="rtl">
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={close}/>
    <form className="mt-modal" onSubmit={submit}>
      <header>
        <h3>نتيجة المتابعة · {contact.name}</h3>
        <button type="button" onClick={close}>×</button>
      </header>
      <div className="mt-customer-summary">
        <div><span>الجوال</span><b>{contact.phone||'—'}</b></div>
        <div><span>الحالة الحالية</span><SalesStatusBadge value={contact.leadStatus}/></div>
        <div><span>الجودة الحالية</span><SalesQualityBadge value={contact.leadQuality}/></div>
        <div><span>الدورة</span><b>{contact.interestCourseName||'لم تحدد'}</b></div>
      </div>
      <div className="mt-form">
        <label className="mt-field">وسيلة التواصل<select name="activity_type"><option value="call">مكالمة</option><option value="whatsapp">واتساب</option><option value="meeting">اجتماع</option><option value="email">بريد إلكتروني</option><option value="note">ملاحظة</option></select></label>
        <label className="mt-field">حالة العميل<StatusSelect name="lead_status" value={followupStatus} onChange={event=>setFollowupStatus(event.target.value)}/></label>
        <label className="mt-field">الدورة المهتم بها<select
          name="course_id"
          value={selectedCourseId}
          onChange={event=>setSelectedCourseId(event.target.value)}
          required={followupStatus==='payment_submitted'}
        >
          <option value="">لم تحدد الدورة بعد</option>
          {courses.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}
        </select></label>
        <label className="mt-field">جودة الليد<QualitySelect name="lead_quality" defaultValue={contact.leadQuality}/></label>
        <label className="mt-field wide">ما الذي حدث؟<textarea name="summary" rows="4" required placeholder="اكتب ملخصًا واضحًا لنتيجة التواصل"/></label>

        {OPEN_STATUSES.has(followupStatus)&&<>
          <label className="mt-field">الإجراء التالي<ActionSelect name="next_action_type" preferred={followupStatus==='awaiting_payment'?'payment_followup':'follow_up'}/></label>
          <label className="mt-field">موعد الإجراء التالي<input name="next_action_at" type="datetime-local" required/></label>
        </>}

        {followupStatus==='payment_submitted'&&<>
          <div className="mt-form-section wide review"><b>بلاغ دفع بانتظار التحقق</b><small>هذا لا يؤكد الدفع. سيُرسل الطلب إلى التسجيل والقبول لمراجعة الإيصال أو بوابة الدفع.</small></div>
          <label className="mt-field">الدفعة<select name="course_run_id"><option value="">لم تحدد الدفعة بعد</option>{availableRuns.map(item=><option value={item.id} key={item.id}>{item.title} · {dateOnly(item.startsAt)}</option>)}</select></label>
          <label className="mt-field">المبلغ المبلّغ عنه<input name="payment_amount" type="number" min="0" step=".01"/></label>
          <label className="mt-field">مرجع / رقم العملية<input name="payment_reference"/></label>
          <label className="mt-field">بداية مفضلة<input name="preferred_start_date" type="date"/></label>
        </>}

        {!OPEN_STATUSES.has(followupStatus)&&followupStatus!=='payment_submitted'&&<>
          <div className="mt-form-section wide closed">
            <b>سيتم إغلاق المتابعة البيعية</b>
            <small>يمكن إعادة فتح العميل لاحقًا، وسيظل سبب الإغلاق والانتقال محفوظين في السجل.</small>
          </div>
          <label className="mt-field wide">سبب الإغلاق<textarea name="closure_reason" rows="3" required placeholder="اكتب سببًا واضحًا يمكن تحليله لاحقًا"/></label>
        </>}

        {error&&<div className="mt-alert error mt-field wide">{error}</div>}
      </div>
      <footer>
        <button type="button" className="mt-button" onClick={close}>إلغاء</button>
        <button className="mt-button primary" disabled={busy}>
          {busy?'جارٍ الحفظ…':followupStatus==='payment_submitted'?'إرسال للتحقق من الدفع':'حفظ النتيجة'}
        </button>
      </footer>
    </form>
  </div>;
}
