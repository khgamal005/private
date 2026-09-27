'use client';

import dynamic from 'next/dynamic';
import {useEffect,useRef,useState} from 'react';
import SalesFollowupDetails,{useFollowupDetails} from './sales-followup-details';
import {serializeFollowupDetails} from '../lib/sales-followup-details.mjs';
import {businessDateTimeToInstant} from '../lib/task-timing.mjs';

const CustomerHistoryDrawer=dynamic(
  ()=>import('./customer-history-drawer'),
  {ssr:false}
);

const EMPTY=[];

export const OPEN_STATUSES=new Set([
  'new',
  'no_answer',
  'busy',
  'phone_off',
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
  phone_off:{label:'الجوال مغلق',tone:'warning'},
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
    timeZone:'UTC',
    day:'numeric',
    month:'short',
    year:'numeric'
  }):'لم يحدد';
}

function dateTime(value,timeZone){
  return value?new Date(value).toLocaleString('ar-SA',{
    timeZone,
    day:'numeric',
    month:'short',
    year:'numeric',
    hour:'2-digit',
    minute:'2-digit'
  }):'';
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

export function QualitySelect({
  defaultValue='unrated',
  value,
  allowUnqualified=true,
  ...props
}){
  const selection=value===undefined
    ?{defaultValue:defaultValue||'unrated'}
    :{value};
  return <div className="mt-quality-control">
    <select {...selection} {...props}>
      {Object.entries(QUALITY)
        .filter(([key])=>allowUnqualified||key!=='unqualified')
        .map(([key,item])=><option value={key} key={key}>{item.label}</option>)}
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
  timeZone='UTC',
  contact,
  task=null,
  courses=EMPTY,
  onClose,
  onSaved
}){
  const initialQuality=contact?.leadQuality||'unrated';
  const [followupStatus,setFollowupStatus]=useState(
    initialQuality==='unqualified'
      ?'unqualified'
      :OPEN_STATUSES.has(contact?.leadStatus)?contact.leadStatus:'follow_up'
  );
  const [followupQuality,setFollowupQuality]=useState(initialQuality);
  const {details,setDetails,loadError,retry}=useFollowupDetails(slug,contact.id);
  const [paymentCourseId,setPaymentCourseId]=useState('');
  const [opportunityId,setOpportunityId]=useState('');
  const command=useRef(null);
  const [contactName,setContactName]=useState(contact?.name||'');
  const [historyOpen,setHistoryOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const baseContact=details?.baseContact;
  useEffect(()=>{
    if(!baseContact)return;
    setContactName(baseContact.name||'');
    const quality=baseContact.leadQuality||'unrated';
    setFollowupQuality(quality);
    setFollowupStatus(quality==='unqualified'?'unqualified':OPEN_STATUSES.has(baseContact.leadStatus)?baseContact.leadStatus:'follow_up');
  },[baseContact]);
  const openOpportunities=details?.openOpportunities||EMPTY;
  const resolvedOpportunityId=openOpportunities.some(item=>item.id===opportunityId)
    ?opportunityId:openOpportunities.length===1?openOpportunities[0].id:'';
  const selectedOpportunity=openOpportunities.find(item=>item.id===resolvedOpportunityId);
  const underAdmissions=['paid','payment_submitted'].includes(baseContact?.leadStatus)&&openOpportunities.length===0;

  const selectedInterests=details?.rows.filter(row=>row.courseId)||EMPTY;
  const canBindPaymentCourse=!selectedOpportunity?.courseId&&(
    selectedOpportunity?.canBindPaymentCourse===true||selectedOpportunity?.kind==='legacy_unclassified'
  );
  const paymentInterests=selectedOpportunity&&!canBindPaymentCourse
    ?selectedInterests.filter(row=>row.courseId===selectedOpportunity.courseId):selectedInterests;
  const resolvedPaymentCourseId=paymentInterests.some(row=>row.courseId===paymentCourseId)
    ?paymentCourseId:paymentInterests.length===1?paymentInterests[0].courseId:'';
  const paymentCourseHelp=!paymentInterests.length
    ?selectedOpportunity&&!selectedOpportunity.courseId&&!canBindPaymentCourse
      ?'هذه فرصة عامة؛ اختر فرصة تدريب مرتبطة بدورة، أو أنشئ فرصة تدريب من ملف العميل.'
      :selectedOpportunity?.courseId
        ?'أضف دورة الفرصة إلى الدورات المهتم بها، أو اختر الفرصة المطابقة للدورة التي سددها العميل.'
        :'اختر الدورة من قسم الدورات المهتم بها أولًا.'
    :canBindPaymentCourse
      ?'ستُربط الدورة المختارة بنفس فرصة العميل عند إرسال البلاغ، مع الاحتفاظ بسجلها واستخدام الدفعة وموعد الحضور المختارين.'
      :'تُستخدم الدفعة وموعد الحضور المختاران لهذه الدورة. باقي الدورات تظل اهتمامات محفوظة.';

  function changeStatus(nextStatus){
    setFollowupStatus(nextStatus);
    if(nextStatus==='unqualified'){
      setFollowupQuality('unqualified');
    }else if(OPEN_STATUSES.has(nextStatus)&&followupQuality==='unqualified'){
      setFollowupQuality('unrated');
    }
  }

  function changeQuality(nextQuality){
    setFollowupQuality(nextQuality);
    if(nextQuality==='unqualified')setFollowupStatus('unqualified');
  }

  function close(){
    if(!busy){
      setHistoryOpen(false);
      onClose();
    }
  }

  async function submit(event){
    event.preventDefault();
    if(busy||underAdmissions)return;
    setBusy(true);
    setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const open=OPEN_STATUSES.has(values.lead_status);
    const paymentSubmitted=values.lead_status==='payment_submitted';

    try{
      const serialized=serializeFollowupDetails(details);
      if(openOpportunities.length>1&&!resolvedOpportunityId)throw new Error('اختر الفرصة التي تخصها هذه المتابعة.');
      if(paymentSubmitted&&!resolvedPaymentCourseId)throw new Error('حدد الدورة التي يخصها بلاغ الدفع.');
      const body={
        p_tenant_slug:slug,p_contact_id:contact.id,p_task_id:task?.id||null,
        p_opportunity_id:resolvedOpportunityId||null,
        p_contact_name:values.contact_name,p_activity_type:values.activity_type,p_summary:values.summary,
        p_lead_status:values.lead_status,p_lead_quality:values.lead_quality,
        p_next_action_type:open?values.next_action_type:null,
        p_next_action_at:open?businessDateTimeToInstant(values.next_action_at,timeZone):null,
        p_course_interests:serialized.courseInterests,p_additional_phones:serialized.additionalPhones,
        p_expected_revision:details.revision,p_payment_course_id:paymentSubmitted?resolvedPaymentCourseId:null,
        p_payment_amount_minor:paymentSubmitted&&values.payment_amount?Math.round(Number(values.payment_amount)*100):null,
        p_payment_reference:paymentSubmitted?(values.payment_reference||null):null,
        p_closure_reason:!open&&!paymentSubmitted?(values.closure_reason||null):null
      };
      const signature=JSON.stringify(body);
      if(command.current?.signature!==signature)command.current={signature,id:crypto.randomUUID()};
      const response=await fetch('/api/tenant/record-sales-followup',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({...body,p_command_id:command.current.id})
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر حفظ نتيجة المتابعة');
      const message=payload.data?.paymentReviewNotified
        ?'تم إرسال بلاغ الدفع إلى التسجيل والقبول للتحقق قبل التأكيد'
        :!open
          ?'تم حفظ النتيجة وإغلاق متابعة الفرصة المحددة مع إبقاء متابعة الفرص الأخرى'
        :payload.data?.taskUpdated
          ?'تم حفظ النتيجة ونقل مهمة المتابعة نفسها إلى الموعد الجديد'
          :'تم حفظ النتيجة وإنشاء مهمة الإجراء التالي الأولى';
      onSaved(message,payload.data);
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  return <div
    className={`mt-modal-layer mt-followup-modal-layer ${historyOpen?'is-split':''}`}
    dir="rtl"
  >
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={close}/>
    <form className="mt-modal mt-followup-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="sales-followup-title" aria-busy={busy}>
      <header>
        <h3 id="sales-followup-title">نتيجة المتابعة · {contactName||contact.name}</h3>
        <div className="mt-followup-head-actions">
          <button
            type="button"
            className={`mt-button soft mt-followup-history-button ${historyOpen?'active':''}`}
            onClick={()=>setHistoryOpen(current=>!current)}
            aria-expanded={historyOpen}
            aria-controls="customer-history-title"
          >
            <span aria-hidden="true">☷</span>
            {historyOpen?'إخفاء سجل العميل':'سجل العميل'}
          </button>
          <button
            type="button"
            className="mt-followup-close"
            onClick={close}
            aria-label="إغلاق"
          >×</button>
        </div>
      </header>
      <div className="mt-customer-summary">
        <div><span>الجوال</span><b>{contact.phone||'—'}</b></div>
        <div><span>الحالة الحالية</span><SalesStatusBadge value={contact.leadStatus}/></div>
        <div><span>الجودة الحالية</span><SalesQualityBadge value={contact.leadQuality}/></div>
        <div><span>الدورة</span><b>{contact.interestCourseName||'لم تحدد'}</b></div>
        {(contact.latestNote||contact.notes)&&<div className="mt-customer-latest-note">
          <span>آخر ملاحظة مسجلة</span>
          <b>{contact.latestNote||contact.notes}</b>
          {contact.latestNoteAt&&<small>{dateTime(contact.latestNoteAt,timeZone)}</small>}
        </div>}
      </div>
      <fieldset className="mt-form" disabled={busy} style={{border:0,margin:0,minWidth:0}}>
        <label className="mt-field wide">اسم العميل<input
          name="contact_name"
          value={contactName}
          onChange={event=>setContactName(event.target.value)}
          required
          minLength="2"
          maxLength="150"
          autoComplete="name"
        /></label>
        <label className="mt-field">وسيلة التواصل<select name="activity_type"><option value="call">مكالمة</option><option value="whatsapp">واتساب</option><option value="meeting">اجتماع</option><option value="email">بريد إلكتروني</option><option value="note">ملاحظة</option></select></label>
        {openOpportunities.length>0&&<label className="mt-field">الفرصة التي تخصها المتابعة<select value={resolvedOpportunityId} required onChange={event=>setOpportunityId(event.target.value)}><option value="">اختر الفرصة</option>{openOpportunities.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
        <label className="mt-field">حالة متابعة الفرصة<StatusSelect
          name="lead_status"
          value={followupStatus}
          onChange={event=>changeStatus(event.target.value)}
        /></label>
        <label className="mt-field">جودة الليد<QualitySelect
          name="lead_quality"
          value={followupQuality}
          onChange={event=>changeQuality(event.target.value)}
        /></label>
        <SalesFollowupDetails slug={slug} contactId={contact.id} courses={courses}
          details={details} setDetails={setDetails} loadError={loadError} retry={retry} busy={busy}/>
        <label className="mt-field wide">ما الذي حدث؟<textarea name="summary" rows="4" required placeholder="اكتب ملخصًا واضحًا لنتيجة التواصل"/></label>

        {OPEN_STATUSES.has(followupStatus)&&<>
          <label className="mt-field">الإجراء التالي<ActionSelect name="next_action_type" preferred={followupStatus==='awaiting_payment'?'payment_followup':'follow_up'}/></label>
          <label className="mt-field">موعد الإجراء التالي — بتوقيت {timeZone}<input name="next_action_at" type="datetime-local" required/><small>الساعة للتنظيم والترتيب فقط؛ تُعد المتابعة متأخرة بعد انتهاء اليوم كاملًا.</small></label>
        </>}

        {followupStatus==='payment_submitted'&&<>
          <div className="mt-form-section wide review"><b>بلاغ دفع بانتظار التحقق</b><small>هذا لا يؤكد الدفع. تتحقق المالية من الإيصال أو بوابة الدفع، ثم يستكمل التسجيل والقبول إجراءات الطالب.</small></div>
          <label className="mt-field">الدورة التي يخصها بلاغ الدفع<select required value={resolvedPaymentCourseId} onChange={event=>setPaymentCourseId(event.target.value)}>
            <option value="">حدد دورة البلاغ</option>{paymentInterests.map(item=><option key={item.courseId} value={item.courseId}>{courses.find(course=>course.id===item.courseId)?.nameAr||item.courseName}</option>)}
          </select><small role="status">{paymentCourseHelp}</small></label>
          <label className="mt-field">المبلغ المبلّغ عنه<input name="payment_amount" type="number" min="0" step=".01"/></label>
          <label className="mt-field">مرجع / رقم العملية<input name="payment_reference"/></label>
        </>}

        {!OPEN_STATUSES.has(followupStatus)&&followupStatus!=='payment_submitted'&&<>
          <div className="mt-form-section wide closed">
            <b>سيتم إغلاق متابعة الفرصة المحددة</b>
            <small>يُحفظ سبب الإغلاق في السجل، وتستمر متابعة أي فرص أخرى مفتوحة للعميل.</small>
          </div>
          <label className="mt-field wide">سبب الإغلاق<textarea name="closure_reason" rows="3" required placeholder="اكتب سببًا واضحًا يمكن تحليله لاحقًا"/></label>
        </>}

        {underAdmissions&&<div className="mt-alert mt-field wide">التسجيل الحالي مع التسجيل والقبول. لبيع برنامج آخر، أغلق النافذة واختر «فرصة جديدة» من ملف العميل.</div>}
        {error&&<div className="mt-alert error mt-field wide" role="alert">{error}</div>}
      </fieldset>
      <footer>
        <button type="button" className="mt-button" onClick={close}>إلغاء</button>
        <button className="mt-button primary" disabled={busy||!details||underAdmissions||(followupStatus==='payment_submitted'&&!paymentInterests.length)}>
          {busy?'جارٍ الحفظ…':followupStatus==='payment_submitted'?'إرسال للتحقق من الدفع':'حفظ النتيجة'}
        </button>
      </footer>
    </form>

    {historyOpen&&<CustomerHistoryDrawer
      slug={slug}
      contact={contact}
      canEdit={false}
      onClose={()=>setHistoryOpen(false)}
    />}
  </div>;
}
