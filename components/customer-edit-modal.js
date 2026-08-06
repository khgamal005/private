'use client';

import {useState} from 'react';

const EMPTY=[];

export default function CustomerEditModal({
  slug,
  contact,
  courses=EMPTY,
  onClose,
  onSaved
}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  function close(){
    if(!busy)onClose();
  }

  async function submit(event){
    event.preventDefault();
    setBusy(true);
    setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());

    if(!String(values.phone||'').trim()&&!String(values.whatsapp||'').trim()){
      setError('يجب إدخال رقم الجوال أو رقم واتساب على الأقل');
      setBusy(false);
      return;
    }

    try{
      const response=await fetch('/api/tenant/update-sales-contact',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_contact_id:contact.id,
          p_full_name:values.full_name,
          p_phone:values.phone||null,
          p_whatsapp:values.whatsapp||null,
          p_email:values.email||null,
          p_organization_name:values.organization_name||null,
          p_interest_course_id:values.interest_course_id||null,
          p_notes:values.notes||null
        })
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر تعديل بيانات العميل');
      onSaved('تم تحديث بيانات العميل وحفظ التغيير في سجله',payload.data);
    }catch(saveError){
      setError(saveError.message);
    }finally{
      setBusy(false);
    }
  }

  return <div className="mt-modal-layer" dir="rtl">
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={close}/>
    <form className="mt-modal" onSubmit={submit}>
      <header>
        <div>
          <small>تعديل آمن للبيانات الأساسية</small>
          <h3>بيانات العميل</h3>
        </div>
        <button type="button" onClick={close}>×</button>
      </header>

      <div className="mt-form">
        <label className="mt-field wide">اسم العميل<input
          name="full_name"
          defaultValue={contact.name||''}
          required
          minLength="2"
          maxLength="150"
          autoComplete="name"
        /></label>
        <label className="mt-field">رقم الجوال<input
          name="phone"
          defaultValue={contact.phone||''}
          inputMode="tel"
          autoComplete="tel"
        /></label>
        <label className="mt-field">رقم واتساب<input
          name="whatsapp"
          defaultValue={contact.whatsapp||''}
          inputMode="tel"
        /></label>
        <label className="mt-field">البريد الإلكتروني<input
          name="email"
          type="email"
          defaultValue={contact.email||''}
          autoComplete="email"
        /></label>
        <label className="mt-field">الجهة / الشركة<input
          name="organization_name"
          defaultValue={contact.organizationName||''}
          maxLength="200"
        /></label>
        <label className="mt-field">الدورة المهتم بها<select
          name="interest_course_id"
          defaultValue={contact.interestCourseId||''}
        >
          <option value="">غير محددة</option>
          {courses.map(course=><option value={course.id} key={course.id}>{course.nameAr}</option>)}
        </select></label>
        <label className="mt-field wide">ملاحظات العميل<textarea
          name="notes"
          rows="4"
          defaultValue={contact.notes||''}
          maxLength="2000"
          placeholder="معلومات ثابتة مهمة عن العميل تظهر داخل سجله"
        /></label>

        <div className="mt-form-section wide">
          <b>حدود الصلاحية</b>
          <small>لا يمكن من هنا تغيير مسؤول العميل أو المصدر والحملة أو أي بيانات نظامية.</small>
        </div>
        {error&&<div className="mt-alert error mt-field wide">{error}</div>}
      </div>

      <footer>
        <button type="button" className="mt-button" onClick={close}>إلغاء</button>
        <button className="mt-button primary" disabled={busy}>
          {busy?'جارٍ الحفظ…':'حفظ بيانات العميل'}
        </button>
      </footer>
    </form>
  </div>;
}
