'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const accountLabels={
  profile_only:'ملف وظيفي فقط',
  invited:'دعوة معلقة',
  active:'حساب نشط',
  suspended:'حساب موقوف'
};

export default function TeamDirectory({slug,initialData,canManage}){
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [department,setDepartment]=useState('all');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const staff=useMemo(()=>initialData.employees||[],[initialData.employees]);
  const departments=initialData.departments||[];
  const roles=initialData.roles||[];
  const shown=useMemo(()=>staff.filter(item=>{
    const matchesDepartment=department==='all'||item.departmentKey===department;
    const haystack=`${item.name||''} ${item.jobTitle||''} ${item.role||''} ${item.department||''}`;
    return matchesDepartment&&haystack.toLowerCase().includes(query.toLowerCase());
  }),[staff,department,query]);
  const sales=staff.filter(item=>['sales_user','sales_supervisor','sales_manager'].includes(item.roleKey));
  const activeAccounts=staff.filter(item=>item.accountStatus==='active').length;
  const managerProfiles=staff.filter(item=>['tenant_admin','executive_manager'].includes(item.roleKey));

  async function createStaff(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/tenant/create-staff',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_full_name:values.full_name,
          p_role_key:values.role_key,
          p_department_key:values.department_key,
          p_job_title:values.job_title,
          p_email:values.email||null,
          p_phone:values.phone||null
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر إضافة الموظف');
      setMessage('تم إنشاء الملف الوظيفي وربطه بهيكل المنشأة');
      setModal(false);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>PEOPLE & ACCESS</small>
        <h2>فريق عمل ريف المهارات</h2>
        <p>الملف الوظيفي مستقل عن حساب الدخول؛ يمكن إكمال البريد وإرسال الدعوة لاحقًا دون فقد بيانات الموظف.</p>
      </div>
      <div className="mt-page-actions">
        {canManage&&<button className="mt-button primary" onClick={()=>setModal(true)}>+ إضافة موظف</button>}
      </div>
    </header>

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}
    {!managerProfiles.length&&<section className="mt-data-note warning">
      <div><b>ملفا مدير المنشأة والمدير التنفيذي بانتظار بياناتك</b><p>الأدوار وصلاحياتهما الكاملة جاهزة، ولم ننشئ أسماء أو حسابات وهمية.</p></div>
      <span>بيانات مطلوبة</span>
    </section>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>إجمالي الفريق</span><b>{staff.length}</b><small>ملفًا وظيفيًا فعليًا</small></article>
      <article className="mt-kpi"><span>فريق المبيعات</span><b>{sales.length}</b><small>7 مسؤولين + مشرف</small></article>
      <article className="mt-kpi"><span>حسابات الدخول النشطة</span><b>{activeAccounts}</b><small>{staff.length-activeAccounts} بانتظار البريد والدعوة</small></article>
      <article className="mt-kpi"><span>الأقسام</span><b>{departments.length}</b><small>إدارة ومبيعات وخدمة عملاء وبيانات</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={department==='all'?'active':''} onClick={()=>setDepartment('all')}>الكل</button>
          {departments.map(item=><button
            className={department===item.key?'active':''}
            onClick={()=>setDepartment(item.key)}
            key={item.id}
          >{item.nameAr}</button>)}
        </div>
        <input
          className="mt-search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث بالاسم أو الوظيفة"
        />
      </div>
      <div className="mt-team-grid">
        {shown.map(item=><article className="mt-person-card" key={item.id}>
          <header>
            <span className="mt-person-avatar">{item.name?.[0]||'م'}</span>
            <div><h3>{item.name}</h3><p>{item.jobTitle||item.role}</p></div>
            <em className={item.status==='active'?'mt-status active':'mt-status'}>{item.status==='active'?'نشط':item.status}</em>
          </header>
          <dl>
            <div><dt>القسم</dt><dd>{item.department||'غير محدد'}</dd></div>
            <div><dt>الدور</dt><dd>{item.role||item.roleKey}</dd></div>
            <div><dt>البريد</dt><dd>{item.email||'لم يضف بعد'}</dd></div>
            <div><dt>الجوال</dt><dd>{item.phone||'لم يضف بعد'}</dd></div>
          </dl>
          <footer>
            <span className={`mt-account-state ${item.accountStatus==='active'?'active':''}`}>
              {accountLabels[item.accountStatus]||item.accountStatus}
            </span>
          </footer>
        </article>)}
        {!shown.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}
      </div>
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createStaff}>
        <header><div><small>STAFF PROFILE</small><h3>إضافة موظف إلى المنشأة</h3></div><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">اسم الموظف<input name="full_name" required/></label>
          <label className="mt-field">المسمى الوظيفي<input name="job_title" required/></label>
          <label className="mt-field">الدور<select name="role_key" defaultValue="sales_user">
            {roles.map(role=><option value={role.key} key={role.key}>{role.nameAr}</option>)}
          </select></label>
          <label className="mt-field">القسم<select name="department_key" defaultValue="sales">
            {departments.map(item=><option value={item.key} key={item.key}>{item.nameAr}</option>)}
          </select></label>
          <label className="mt-field">البريد — اختياري<input name="email" type="email"/></label>
          <label className="mt-field">الجوال — اختياري<input name="phone" inputMode="tel"/></label>
          <div className="mt-field wide mt-inline-help">إذا لم تضف البريد الآن، سيُنشأ ملف الموظف دون حساب دخول ويمكن دعوته لاحقًا.</div>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button>
          <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ الملف الوظيفي'}</button>
        </footer>
      </form>
    </div>}
  </>;
}
