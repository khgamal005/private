'use client';

import {useRef,useState} from 'react';
import {businessDateTimeToInstant} from '../lib/task-timing.mjs';

export default function CustomerOpportunityModal({slug,contact,courses=[],timeZone='UTC',onClose,onSaved}){
  const [kind,setKind]=useState('training');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const command=useRef(null);
  async function submit(event){
    event.preventDefault();
    if(busy)return;
    setBusy(true);setError('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget).entries());
      if(Boolean(values.next_action_type)!==Boolean(values.next_action_at)){
        throw new Error('حدد الإجراء وموعده معًا، أو اتركهما معًا دون تحديد.');
      }
      const amount=Number(values.value||0);
      if(!Number.isFinite(amount)||amount<0)throw new Error('قيمة الفرصة غير صالحة.');
      const body={
        p_tenant_slug:slug,p_contact_id:contact.id,p_title:values.title,
        p_opportunity_kind:kind,p_course_id:kind==='training'?values.course_id:null,
        p_value_minor:Math.round(amount*100),p_next_action_type:values.next_action_type||null,
        p_next_action_at:values.next_action_at?businessDateTimeToInstant(values.next_action_at,timeZone):null,
        p_source:values.source||null,p_campaign_name:values.campaign_name||null,p_ad_name:values.ad_name||null
      };
      const signature=JSON.stringify(body);
      if(command.current?.signature!==signature)command.current={signature,id:crypto.randomUUID()};
      const response=await fetch('/api/tenant/create-opportunity',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...body,p_command_id:command.current.id})
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر إنشاء الفرصة');
      onSaved(payload.data?.taskId?'تم إنشاء الفرصة وتحديث مهمة المتابعة الموحدة للعميل.':'تم إنشاء الفرصة. يمكن تحديد موعد المتابعة لاحقًا.');
    }catch(reason){setError(reason.message||'تعذر إنشاء الفرصة');}finally{setBusy(false);}
  }
  return <div className="mt-modal-layer">
    <button className="mt-modal-backdrop" aria-label="إغلاق" disabled={busy} onClick={onClose}/>
    <form className="mt-modal" onSubmit={submit}>
      <div className="mt-modal-header"><h2>فرصة جديدة — {contact.name}</h2><button type="button" disabled={busy} onClick={onClose}>إغلاق</button></div>
      <div className="mt-form">
        <p className="mt-field wide">الفرصة مرتبطة بملف العميل الحالي ومسؤوله: {contact.ownerName||'يُحدد حسب صلاحيات الحساب'}.</p>
        <label className="mt-field">نوع الفرصة<select value={kind} onChange={event=>setKind(event.target.value)}><option value="training">برنامج تدريبي</option><option value="general">استفسار عام</option></select></label>
        <label className="mt-field">عنوان الفرصة<input name="title" required minLength={2} maxLength={250}/></label>
        {kind==='training'&&<label className="mt-field wide">البرنامج<select name="course_id" required defaultValue=""><option value="">اختر البرنامج</option>{courses.map(course=><option value={course.id} key={course.id}>{course.nameAr||course.titleAr||course.name}</option>)}</select></label>}
        <label className="mt-field">القيمة الإجمالية المتوقعة<input name="value" type="number" min="0" step="0.01" defaultValue="0"/></label>
        <label className="mt-field">مصدر هذه الفرصة<select name="source" defaultValue=""><option value="">غير موثق</option><option value="manual">تواصل مباشر</option><option value="meta">Meta</option><option value="google">Google</option><option value="website">الموقع</option><option value="referral">ترشيح</option><option value="whatsapp">واتساب</option></select></label>
        <label className="mt-field">الحملة لهذه الفرصة<input name="campaign_name" maxLength={250}/></label>
        <label className="mt-field">الإعلان لهذه الفرصة<input name="ad_name" maxLength={250}/></label>
        <label className="mt-field">الإجراء التالي — اختياري<select name="next_action_type" defaultValue=""><option value="">يُحدد لاحقًا</option><option value="call">مكالمة</option><option value="whatsapp">واتساب</option><option value="meeting">اجتماع</option><option value="follow_up">متابعة</option><option value="payment_followup">متابعة دفع</option></select></label>
        <label className="mt-field">الموعد بتوقيت {timeZone}<input name="next_action_at" type="datetime-local"/></label>
        {error&&<div className="mt-alert error mt-field wide" role="alert">{error}</div>}
      </div>
      <div className="mt-modal-footer"><button type="button" disabled={busy} onClick={onClose}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'إنشاء الفرصة'}</button></div>
    </form>
  </div>;
}
