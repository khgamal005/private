'use client';

import Link from 'next/link';
import {useRef,useState} from 'react';
import {businessDateTimeToInstant} from '../lib/task-timing.mjs';
import styles from './operating-foundation-panel.module.css';

const CHECKS=[['basicData','بيانات المنشأة'],['firstBranch','الفرع الأول'],['currency','العملة'],
  ['timezone','المنطقة الزمنية'],['taxConfiguration','الإعداد الضريبي'],
  ['teamAndPermissions','الفريق والصلاحيات'],['intakeSource','استقبال العملاء']];
const DAYS=[[1,'الاثنين'],[2,'الثلاثاء'],[3,'الأربعاء'],[4,'الخميس'],[5,'الجمعة'],[6,'السبت'],[7,'الأحد']];
const ERRORS={
  operating_setup_version_conflict:'تغيرت الإعدادات منذ فتح الصفحة. حدّث البيانات ثم راجع التعديل.',
  operating_preview_confirmation_required:'تغيرت بيانات التشغيل. اطلب معاينة جديدة قبل تأكيد القرار.',
  operating_staff_shifts_required:'أضف جدول عمل لكل موظف نشط قبل تفعيل الإسناد حسب المواعيد.',
  operating_setup_required:'احفظ إعداد المنشأة أولًا.',
  operating_timezone_confirmation_required:'أكد تغيير المنطقة الزمنية قبل الحفظ.',
  operating_finance_timezone_permission_required:'يتطلب توحيد توقيت المنشأة والحسابات صلاحية إعدادات الحسابات.',
  operating_cover_department_invalid:'اختر بديلًا نشطًا يعمل في القسم الأساسي للموظف.',
  operating_primary_department_required:'حدد قسمًا أساسيًا نشطًا للموظف.',
  operating_branch_required:'حدد فرعًا نشطًا للموظف.',
  operating_timezone_invalid:'أدخل منطقة زمنية صحيحة مثل Asia/Riyadh.',
  operating_absence_not_found:'الإجازة غير متاحة. حدّث البيانات.',
  forbidden:'ليست لديك صلاحية لتنفيذ هذا الإجراء.'
};
const safeError=message=>ERRORS[message]||(/[\u0600-\u06ff]/.test(String(message||''))
  ?message:'تعذر حفظ التعديل. حدّث البيانات ثم حاول مجددًا.');
const displayDate=(value,timeZone)=>new Intl.DateTimeFormat('ar-SA',{
  calendar:'gregory',timeZone,dateStyle:'medium',timeStyle:'short'
}).format(new Date(value));

export default function OperatingFoundationPanel({slug,initialData}){
  const [data,setData]=useState(initialData);
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [editor,setEditor]=useState(null);
  const [absenceStaff,setAbsenceStaff]=useState(null);
  const [cancelTarget,setCancelTarget]=useState(null);
  const [review,setReview]=useState(null);
  const timeZone=data.tenant?.timezone||'UTC';
  const staff=data.staff||[];
  const branches=data.branches||[];
  const departments=data.departments||[];

  async function request(action,payload={},snapshot=false){
    if(pending.current)return null;
    pending.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch(`/api/tenant/${snapshot?'operating-snapshot':'operating-foundation'}`,{
        method:'POST',headers:{'content-type':'application/json'},cache:'no-store',
        body:JSON.stringify(snapshot?{p_tenant_slug:slug}:{p_tenant_slug:slug,p_action:action,p_payload:payload})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(safeError(result?.error));
      if(!result?.data||typeof result.data!=='object')throw new Error('تعذر قراءة الإعدادات؛ حدّث الصفحة.');
      if(action!=='preview_scheduling'){
        if(!result.data.setup||!result.data.tenant)throw new Error('تعذر قراءة الإعدادات؛ حدّث الصفحة.');
        setData(result.data);setReview(null);
        if(!snapshot)setNotice('تم حفظ التعديل.');
      }
      return result.data;
    }catch(err){
      setError(safeError(err.message));
      if(action==='set_scheduling')setReview(null);
      return null;
    }finally{pending.current=false;setBusy(false);}
  }

  async function previewScheduling(){
    const preview=await request('preview_scheduling');
    if(preview)setReview({...preview,enabled:!data.setup?.staffSchedulingEnabled,confirmed:false});
  }

  return <div className={styles.panel}>
    <header className={styles.header}>
      <div><h1>جاهزية المنشأة وتنظيم الفريق</h1><p>استكمل أساس التشغيل، ثم جهّز الأقسام ومواعيد العمل والتغطية.</p></div>
      <button type="button" disabled={busy} onClick={()=>request(null,{},true)}>تحديث البيانات</button>
    </header>
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {notice&&<div className={styles.success} role="status">{notice}</div>}
    <section className={styles.card} aria-labelledby="operating-readiness-title">
      <div className={styles.schedulingHeader}><h2 id="operating-readiness-title">جاهزية التشغيل الأساسي</h2>
        <span className={data.ready?styles.ready:styles.pending}>{data.ready?'الإعداد الأساسي مكتمل':'يلزم استكمال الإعداد'}</span></div>
      <p>يمكنك بدء استقبال العملاء يدويًا أو بملف Excel أو نموذج داخلي ضمن التشغيل الأساسي.</p>
      <ul className={styles.checks}>{CHECKS.map(([key,label])=><li key={key}>
        <label><input type="checkbox" checked={data.checks?.[key]===true} readOnly disabled/>{label}</label>
      </li>)}</ul>
    </section>
    <section className={styles.card}>
      <h2>بيانات المنشأة والفرع الأول</h2>
      <SetupForm key={`${data.setup?.version}:${timeZone}`} data={data} busy={busy} onSave={payload=>request('save_setup',payload)}/>
      <div className={styles.finance}>
        <div><strong>العملة والإعداد الضريبي</strong><p>{data.finance?.configured
          ?`${data.finance.currency||'—'} · ${data.finance.taxRegistered?'مسجلة ضريبيًا':'غير مسجلة ضريبيًا'}`
          :'استكمل إعداد الحسابات لتحديد العملة والحالة الضريبية.'}</p></div>
        <Link href={`/tenant/${encodeURIComponent(slug)}/accounting/settings`}>فتح إعدادات الحسابات ←</Link>
      </div>
    </section>
    {data.planningQueue?.total>0&&<section className={styles.card} aria-labelledby="opportunity-planning-title">
      <div className={styles.schedulingHeader}><div><h2 id="opportunity-planning-title">فرص تحتاج تحديد متابعة</h2>
        <p>{data.planningQueue.total} فرصة مفتوحة لم يحدد مسؤولها موعد المتابعة بعد. موعد المراجعة الإداري يوم عمل من إنشاء الفرصة.</p></div>
        <Link href={`/tenant/${encodeURIComponent(slug)}/sales`}>فتح المبيعات وتحديد المتابعة</Link></div>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>الفرصة والعميل</th><th>المسؤول</th><th>موعد المراجعة</th></tr></thead>
        <tbody>{(data.planningQueue.items||[]).map(item=><tr key={item.id}><td>{item.title}<small>{item.contactName}</small></td>
          <td>{item.ownerName||'تحتاج إسنادًا'}</td><td>{displayDate(item.reviewAt,timeZone)}</td></tr>)}</tbody>
      </table></div>
    </section>}
    {data.canManagePeople&&<>
      <section className={styles.card}>
        <div className={styles.schedulingHeader}><div><h2>الأقسام ومواعيد العمل</h2><p>جميع المواعيد بتوقيت المنشأة: <b dir="ltr">{timeZone}</b>.</p></div>
          <Link className={styles.button} href={`/tenant/${encodeURIComponent(slug)}/team`}>إدارة الفريق والصلاحيات</Link></div>
        {staff.length?<div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>الموظف</th><th>القسم والفرع</th><th>مواعيد العمل</th><th>الإجراءات</th></tr></thead>
          <tbody>{staff.map(person=><tr key={person.id}><td><strong>{person.name}</strong><small>{person.status==='active'?'نشط':'غير نشط'}</small></td>
            <td>{departments.find(item=>item.id===person.departmentId)?.name||'القسم غير محدد'}<small>{branches.find(item=>item.id===person.branchId)?.name||'الفرع غير محدد'}</small></td>
            <td>{person.shifts?.length?`${person.shifts.length} فترة أسبوعية`:'لم تجهز'}<small>{data.setup?.staffSchedulingEnabled
              ?person.availableNow?'متاح للإسناد الآن':'غير متاح للإسناد الآن':'تطبيق المواعيد غير مفعّل'}</small></td>
            <td><div className={styles.actions}><button type="button" disabled={busy} onClick={()=>{setEditor(person.id);setAbsenceStaff(null);}}>تنظيم العمل</button>
              <button type="button" disabled={busy} onClick={()=>{setAbsenceStaff(person.id);setEditor(null);}}>إجازة</button></div></td></tr>)}</tbody>
        </table></div>:<p className={styles.empty}>أضف أعضاء الفريق لإعداد الأقسام ومواعيد العمل.</p>}
        {editor&&staff.some(item=>item.id===editor)&&<StaffForm key={`${editor}:${data.setup?.version}`} person={staff.find(item=>item.id===editor)}
          departments={departments} branches={branches} busy={busy} timeZone={timeZone} scheduling={data.setup?.staffSchedulingEnabled}
          onClose={()=>setEditor(null)} onSave={async payload=>{if(await request('save_staff_operations',payload))setEditor(null);}}/>}
        {absenceStaff&&staff.some(item=>item.id===absenceStaff)&&<AbsenceForm key={absenceStaff} person={staff.find(item=>item.id===absenceStaff)} staff={staff}
          timeZone={timeZone} busy={busy} onClose={()=>setAbsenceStaff(null)}
          onSave={async payload=>{if(await request('record_absence',payload))setAbsenceStaff(null);}}/>}
        <div className={styles.absences}>{staff.flatMap(person=>(person.absences||[]).map(absence=><article className={styles.absence} key={absence.id}>
          <div><strong>{person.name} · إجازة مسجلة</strong><p>{displayDate(absence.startsAt,timeZone)} ← {displayDate(absence.endsAt,timeZone)}</p>
            <p>{absence.reason}{absence.coverStaffId?` · بديل التغطية: ${staff.find(item=>item.id===absence.coverStaffId)?.name||'موظف مسجل'}`:''}</p></div>
          <button type="button" disabled={busy} className={styles.danger} onClick={()=>setCancelTarget({id:absence.id,name:person.name})}>إلغاء الإجازة</button>
        </article>))}</div>
        {cancelTarget&&<div className={styles.review} role="group" aria-label="تأكيد إلغاء الإجازة">
          <p>إلغاء إجازة {cancelTarget.name}؟ ستُعاد مراعاة جدول عمله في الإسناد عند تفعيل المواعيد.</p>
          <div className={styles.actions}><button type="button" className={styles.danger} disabled={busy} onClick={async()=>{
            if(await request('cancel_absence',{absenceId:cancelTarget.id}))setCancelTarget(null);
          }}>تأكيد إلغاء الإجازة</button><button type="button" disabled={busy} onClick={()=>setCancelTarget(null)}>تراجع</button></div>
        </div>}
      </section>
      <section className={styles.card} aria-labelledby="staff-scheduling-title">
        <div className={styles.schedulingHeader}><div><h2 id="staff-scheduling-title">الإسناد حسب مواعيد العمل والإجازات</h2>
          <p>عند التفعيل، تُستبعد الإجازات والأوقات خارج جدول العمل من الإسناد الجديد. يحتفظ الفريق بعملائه ومهامه الحالية.</p></div>
          <span className={data.setup?.staffSchedulingEnabled?styles.ready:styles.pending}>{data.setup?.staffSchedulingEnabled?'مفعّل':'غير مفعّل'}</span></div>
        <button type="button" className={styles.primary} disabled={busy||!data.setup?.version} onClick={previewScheduling}>
          {data.setup?.staffSchedulingEnabled?'مراجعة إيقاف تطبيق المواعيد':'مراجعة تفعيل تطبيق المواعيد'}</button>
        {!data.setup?.version&&<p className={styles.help}>احفظ إعداد المنشأة أولًا، ثم جهّز مواعيد الموظفين قبل التفعيل.</p>}
        {review&&<div className={styles.review} role="group" aria-label="مراجعة تطبيق مواعيد العمل">
          <h3>{review.enabled?'تفعيل تطبيق المواعيد':'إيقاف تطبيق المواعيد'}</h3>
          <div className={styles.previewNumbers}><span><b>{review.activeStaff}</b>موظف نشط</span><span><b>{review.withoutShift}</b>موظف بلا جدول عمل</span></div>
          {review.enabled&&review.withoutShift>0&&<p className={styles.error}>استكمل جداول الموظفين النشطين قبل التفعيل.</p>}
          {!review.enabled&&<p>سيعود الإسناد إلى قواعده الأساسية دون استبعاد الموظف بسبب مواعيد العمل أو الإجازة المسجلة هنا.</p>}
          <label className={styles.check}><input type="checkbox" checked={review.confirmed} disabled={busy}
            onChange={event=>setReview({...review,confirmed:event.target.checked})}/>راجعت الأثر وأؤكد هذا القرار.</label>
          <div className={styles.actions}><button type="button" className={styles.primary}
            disabled={busy||!review.confirmed||(review.enabled&&review.withoutShift>0)}
            onClick={()=>request('set_scheduling',{enabled:review.enabled,confirmed:true,expectedVersion:review.version})}>تأكيد {review.enabled?'التفعيل':'الإيقاف'}</button>
            <button type="button" disabled={busy} onClick={()=>setReview(null)}>تراجع</button></div>
        </div>}
      </section>
    </>}
    {!data.canManagePeople&&<p className={styles.help}>إعداد مواعيد الفريق والإجازات متاح لمن لديه صلاحية إدارة فريق العمل.</p>}
  </div>;
}

function SetupForm({data,busy,onSave}){
  const branch=(data.branches||[]).find(item=>item.is_default);
  const [timeZone,setTimeZone]=useState(data.tenant?.timezone||'Asia/Riyadh');
  const changedTimeZone=timeZone!==data.tenant?.timezone;
  return <form onSubmit={event=>{
    event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
    onSave({...values,expectedVersion:data.setup?.version||0,confirmTimezoneChange:values.confirmTimezoneChange==='on'});
  }}><fieldset disabled={busy} className={styles.form}>
    <label>اسم المنشأة<input name="name" defaultValue={data.tenant?.name||''} required minLength={2} maxLength={160}/></label>
    <label>الاسم القانوني<input name="legalName" defaultValue={data.tenant?.legalName||''} required minLength={2} maxLength={200}/></label>
    <label>الفرع الأول<input name="firstBranchName" defaultValue={branch?.name||'الفرع الرئيسي'} readOnly={Boolean(branch)} required minLength={2} maxLength={160}/></label>
    <label>المنطقة الزمنية<input name="timezone" value={timeZone} onChange={event=>setTimeZone(event.target.value)} list="operating-timezones" required dir="ltr"/>
      <datalist id="operating-timezones">{['Asia/Riyadh','Africa/Cairo','Asia/Dubai','UTC'].map(zone=><option value={zone} key={zone}/>)}</datalist></label>
    <label className={styles.wide}>مصدر استقبال العملاء<select name="intakeSource" defaultValue={data.setup?.intakeSource||'manual'} required>
      <option value="manual">إدخال يدوي</option><option value="excel">استيراد ملف Excel</option>
      <option value="internal_form">نموذج داخلي</option><option value="integration">تكامل خارجي مفعّل</option>
    </select></label>
    {changedTimeZone&&<label className={`${styles.check} ${styles.wide}`}><input type="checkbox" name="confirmTimezoneChange" required/>
      أؤكد تغيير توقيت المنشأة والحسابات. سيتغير عرض المواعيد وحدود الأيام في التقارير.</label>}
    <div className={`${styles.actions} ${styles.wide}`}><button type="submit" className={styles.primary}>حفظ إعداد المنشأة</button></div>
  </fieldset></form>;
}

function StaffForm({person,departments,branches,busy,timeZone,scheduling,onSave,onClose}){
  const [primary,setPrimary]=useState(person.departmentId||'');
  const [extras,setExtras]=useState(person.extraDepartments||[]);
  const sequence=useRef(100);
  const [shifts,setShifts]=useState(()=>(person.shifts||[]).map((shift,index)=>({...shift,key:index,
    startsAt:shift.startsAt.slice(0,5),endsAt:shift.endsAt.slice(0,5)})));
  return <form className={styles.staffEditor} onSubmit={event=>{
    event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
    onSave({staffId:person.id,primaryDepartmentId:primary,branchId:values.branchId,
      extraDepartmentIds:extras.filter(id=>id!==primary),shifts:shifts.map(({isoDay,startsAt,endsAt})=>({isoDay:Number(isoDay),startsAt,endsAt}))});
  }}><header><h3>تنظيم عمل {person.name}</h3><button type="button" disabled={busy} onClick={onClose}>إغلاق</button></header>
    <fieldset disabled={busy} className={styles.form}>
      <label>القسم الأساسي<select value={primary} onChange={event=>setPrimary(event.target.value)} required>
        <option value="">اختر القسم</option>{departments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>الفرع<select name="branchId" defaultValue={person.branchId||branches.find(item=>item.is_default)?.id||''} required>
        <option value="">اختر الفرع</option>{branches.filter(item=>item.active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <fieldset className={styles.wide}><legend>أقسام إضافية</legend><div className={styles.extraDepartments}>{departments.filter(item=>item.id!==primary).map(item=><label key={item.id}>
        <input type="checkbox" checked={extras.includes(item.id)} onChange={event=>setExtras(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}/>{item.name}</label>)}</div></fieldset>
      <div className={styles.wide}><h3>جدول العمل الأسبوعي</h3><p className={styles.help}>بتوقيت {timeZone}. إذا كان وقت النهاية أسبق من البداية، تمتد الفترة إلى اليوم التالي.</p>
        {shifts.map((shift,index)=><div className={styles.shift} key={shift.key}>
          <label>اليوم<select value={shift.isoDay} onChange={event=>setShifts(current=>current.map(row=>row.key===shift.key?{...row,isoDay:Number(event.target.value)}:row))}>
            {DAYS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          <label>من<input type="time" value={shift.startsAt} required onChange={event=>setShifts(current=>current.map(row=>row.key===shift.key?{...row,startsAt:event.target.value}:row))}/></label>
          <label>إلى<input type="time" value={shift.endsAt} required onChange={event=>setShifts(current=>current.map(row=>row.key===shift.key?{...row,endsAt:event.target.value}:row))}/></label>
          <button type="button" aria-label={`حذف فترة ${index+1}`} onClick={()=>setShifts(current=>current.filter(row=>row.key!==shift.key))}>حذف</button>
        </div>)}
        <p><button type="button" disabled={shifts.length>=28} onClick={()=>setShifts(current=>[...current,{key:sequence.current++,isoDay:7,startsAt:'09:00',endsAt:'17:00'}])}>+ إضافة فترة عمل</button></p>
        {scheduling&&!shifts.length&&<p className={styles.error}>يلزم وجود فترة عمل واحدة على الأقل أثناء تفعيل المواعيد.</p>}
      </div>
      <div className={`${styles.actions} ${styles.wide}`}><button type="submit" className={styles.primary} disabled={scheduling&&!shifts.length}>حفظ تنظيم العمل</button></div>
    </fieldset>
  </form>;
}

function AbsenceForm({person,staff,timeZone,busy,onSave,onClose}){
  const [error,setError]=useState('');
  const covers=staff.filter(item=>item.id!==person.id&&item.status==='active'
    &&(item.departmentId===person.departmentId||(item.extraDepartments||[]).includes(person.departmentId)));
  return <form className={styles.staffEditor} onSubmit={event=>{
    event.preventDefault();setError('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try{
      const startsAt=businessDateTimeToInstant(values.startsAt,timeZone);
      const endsAt=businessDateTimeToInstant(values.endsAt,timeZone);
      if(endsAt<=startsAt)throw new Error('يجب أن تكون نهاية الإجازة بعد بدايتها.');
      onSave({staffId:person.id,startsAt,endsAt,coverStaffId:values.coverStaffId||null,reason:values.reason});
    }catch(err){setError(err.message);}
  }}><header><h3>تسجيل إجازة {person.name}</h3><button type="button" disabled={busy} onClick={onClose}>إغلاق</button></header>
    <fieldset disabled={busy} className={styles.form}>
      <label>البداية — {timeZone}<input name="startsAt" type="datetime-local" required/></label>
      <label>النهاية — {timeZone}<input name="endsAt" type="datetime-local" required/></label>
      <label className={styles.wide}>بديل التغطية (اختياري)<select name="coverStaffId"><option value="">لم يحدد</option>{covers.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className={styles.wide}>سبب الإجازة<textarea name="reason" required minLength={3} maxLength={500} rows={2}/></label>
      {error&&<p className={`${styles.error} ${styles.wide}`} role="alert">{error}</p>}
      <div className={`${styles.actions} ${styles.wide}`}><button type="submit" className={styles.primary}>حفظ الإجازة</button></div>
    </fieldset>
  </form>;
}
