'use client';

import {useState} from 'react';

const EMPTY=[];
const SALES_ROLES=new Set(['sales_user','sales_supervisor','sales_manager']);

function localDateTime(hours=24){
  const date=new Date(Date.now()+hours*60*60*1000);
  const offset=date.getTimezoneOffset()*60*1000;
  return new Date(date.getTime()-offset).toISOString().slice(0,16);
}

export default function CustomerEditModal({
  slug,
  contact,
  courses=EMPTY,
  staff=EMPTY,
  canEdit=true,
  canReassign=false,
  onClose,
  onSaved
}){
  const [busy,setBusy]=useState(false);
  const [reassignBusy,setReassignBusy]=useState(false);
  const [error,setError]=useState('');
  const [reassignment,setReassignment]=useState({
    newStaffId:'',
    deadlineAt:localDateTime(),
    reason:''
  });
  const eligibleStaff=staff.filter(member=>
    SALES_ROLES.has(member.roleKey)
    &&member.id!==contact.ownerStaffId
  );
  const hasActiveAssignment=Boolean(contact.activeAssignmentId);

  function close(){
    if(!busy&&!reassignBusy)onClose();
  }

  async function submit(event){
    event.preventDefault();
    if(!canEdit){
      setError('صلاحيتك تتيح تغيير الإسناد فقط دون تعديل البيانات الأساسية');
      return;
    }
    setBusy(true);
    setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());

    if(!String(values.phone||'').trim()){
      setError('يجب إدخال رقم الجوال الأساسي');
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

  async function submitReassignment(){
    setError('');
    if(!hasActiveAssignment){
      setError('لا يوجد إسناد نشط لهذا العميل يمكن نقله');
      return;
    }
    if(!reassignment.newStaffId){
      setError('اختر مسؤول المبيعات الجديد');
      return;
    }
    if(reassignment.reason.trim().length<3){
      setError('اكتب سبب تغيير الإسناد');
      return;
    }
    const deadline=new Date(reassignment.deadlineAt);
    if(Number.isNaN(deadline.getTime())||deadline<=new Date()){
      setError('حدد موعد متابعة جديدًا في المستقبل');
      return;
    }

    setReassignBusy(true);
    try{
      const response=await fetch('/api/tenant/lead-reassignment',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_payload:{
            assignmentIds:[contact.activeAssignmentId],
            newStaffId:reassignment.newStaffId,
            deadlineAt:deadline.toISOString(),
            reason:reassignment.reason.trim()
          }
        })
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok){
        throw new Error(payload.error||'تعذر تغيير إسناد العميل');
      }
      const result=payload.data||{};
      onSaved(
        `تم تغيير إسناد العميل إلى ${result.newStaffName||'المسؤول الجديد'} وإرسال الإشعارات وحفظ التغيير في سجله`,
        {
          ...contact,
          ownerStaffId:result.newStaffId||reassignment.newStaffId,
          ownerName:result.newStaffName||contact.ownerName,
          nextActionAt:result.deadlineAt||deadline.toISOString(),
          activeAssignmentId:null
        }
      );
    }catch(reassignmentError){
      setError(reassignmentError.message);
    }finally{
      setReassignBusy(false);
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
          disabled={!canEdit}
          required
          minLength="2"
          maxLength="150"
          autoComplete="name"
        /></label>
        <label className="mt-field">رقم الجوال<input
          name="phone"
          defaultValue={contact.phone||''}
          required={canEdit}
          disabled={!canEdit}
          inputMode="tel"
          autoComplete="tel"
        /></label>
        <label className="mt-field">رقم واتساب<input
          name="whatsapp"
          defaultValue={contact.whatsapp||''}
          disabled={!canEdit}
          inputMode="tel"
        /></label>
        <label className="mt-field">البريد الإلكتروني<input
          name="email"
          type="email"
          defaultValue={contact.email||''}
          disabled={!canEdit}
          autoComplete="email"
        /></label>
        <label className="mt-field">الجهة / الشركة<input
          name="organization_name"
          defaultValue={contact.organizationName||''}
          disabled={!canEdit}
          maxLength="200"
        /></label>
        <label className="mt-field">الدورة المهتم بها<select
          name="interest_course_id"
          defaultValue={contact.interestCourseId||''}
          disabled={!canEdit}
        >
          <option value="">غير محددة</option>
          {courses.map(course=><option value={course.id} key={course.id}>{course.nameAr}</option>)}
        </select></label>
        <label className="mt-field wide">ملاحظات العميل<textarea
          name="notes"
          rows="4"
          defaultValue={contact.notes||''}
          disabled={!canEdit}
          maxLength="2000"
          placeholder="معلومات ثابتة مهمة عن العميل تظهر داخل سجله"
        /></label>

        {canReassign&&<>
          <div className="mt-form-section wide">
            <b>تغيير إسناد العميل</b>
            <small>
              المسؤول الحالي: {contact.ownerName||'غير مسند'} · سيُحفظ النقل في سجل العميل ويُرسل إشعار للإدارة والموظفين المعنيين.
            </small>
          </div>
          {hasActiveAssignment?<>
            <label className="mt-field wide">مسؤول المبيعات الجديد<select
              value={reassignment.newStaffId}
              onChange={event=>setReassignment(current=>({
                ...current,newStaffId:event.target.value
              }))}
              disabled={busy||reassignBusy}
            >
              <option value="">اختر المسؤول الجديد</option>
              {eligibleStaff.map(member=><option value={member.id} key={member.id}>
                {member.name} — {member.jobTitle||member.department||'فريق المبيعات'}
              </option>)}
            </select></label>
            <label className="mt-field">موعد المتابعة الجديد<input
              type="datetime-local"
              min={localDateTime(0.1)}
              max={localDateTime(24*90)}
              value={reassignment.deadlineAt}
              onChange={event=>setReassignment(current=>({
                ...current,deadlineAt:event.target.value
              }))}
              disabled={busy||reassignBusy}
            /></label>
            <label className="mt-field wide">سبب تغيير الإسناد<textarea
              rows="3"
              minLength="3"
              maxLength="500"
              value={reassignment.reason}
              onChange={event=>setReassignment(current=>({
                ...current,reason:event.target.value
              }))}
              disabled={busy||reassignBusy}
              placeholder="مثال: إعادة توزيع الحمل أو انتقال الموظف إلى فريق آخر"
            /></label>
            <div className="mt-field wide">
              <button
                type="button"
                className="mt-button primary"
                disabled={busy||reassignBusy}
                onClick={submitReassignment}
              >
                {reassignBusy
                  ?'جارٍ تغيير الإسناد…'
                  :'تأكيد تغيير الإسناد وإرسال الإشعارات'}
              </button>
            </div>
          </>:<div className="mt-alert error mt-field wide">
            لا يوجد إسناد نشط لهذا العميل حاليًا؛ راجع سجل التوزيع قبل النقل.
          </div>}
        </>}

        <div className="mt-form-section wide">
          <b>حدود الصلاحية</b>
          <small>لا يمكن من هنا تغيير المصدر أو الحملة أو أي بيانات نظامية أخرى.</small>
        </div>
        {error&&<div className="mt-alert error mt-field wide">{error}</div>}
      </div>

      <footer>
        <button type="button" className="mt-button" onClick={close}>إلغاء</button>
        {canEdit&&<button className="mt-button primary" disabled={busy||reassignBusy}>
          {busy?'جارٍ الحفظ…':'حفظ بيانات العميل'}
        </button>}
      </footer>
    </form>
  </div>;
}
