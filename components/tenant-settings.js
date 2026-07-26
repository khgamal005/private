'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

export default function TenantSettings({slug,initialData}){
  const router=useRouter();
  const [tab,setTab]=useState('users');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const employees=initialData.employees||[];
  const roles=initialData.roles||[];
  const departments=initialData.departments||[];
  const shown=useMemo(()=>employees.filter(employee=>
    `${employee.name||''} ${employee.email||''} ${employee.role||''} ${employee.department||''}`.toLowerCase().includes(query.toLowerCase())
  ),[employees,query]);

  async function createEmployee(event){
    event.preventDefault();
    setBusy(true);setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/crm/create-employee',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          p_tenant_slug:slug,p_full_name:values.full_name,p_email:values.email||null,
          p_phone:values.phone||null,p_department_id:values.department_id||null,
          p_job_role_id:values.job_role_id||null,p_manager_employee_id:values.manager_employee_id||null,
          p_capacity_minutes_weekly:Number(values.capacity_minutes_weekly||2400)
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر إضافة الموظف');
      setMessage('تم إنشاء ملف الموظف داخل المنشأة');
      setModal(false);router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div><small>TENANT SETTINGS</small><h2>إعدادات المنشأة والصلاحيات</h2><p>الموظفون والهيكل والأدوار في مكان واحد واضح.</p></div>
      <div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ إضافة موظف</button></div>
    </header>
    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>الموظفون</span><b>{employees.length}</b><small>{employees.filter(item=>item.status==='active').length} حسابًا نشطًا</small></article>
      <article className="mt-kpi"><span>الأدوار الوظيفية</span><b>{roles.length}</b><small>قوالب صلاحيات داخل المنشأة</small></article>
      <article className="mt-kpi"><span>الأقسام</span><b>{departments.length}</b><small>الهيكل التنظيمي الحالي</small></article>
      <article className="mt-kpi"><span>السعة الأسبوعية</span><b>{employees.reduce((sum,item)=>sum+Number(item.capacityMinutesWeekly||0),0)}</b><small>دقيقة عمل مخططة</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={tab==='users'?'active':''} onClick={()=>setTab('users')}>الموظفون والمستخدمون</button>
          <button className={tab==='roles'?'active':''} onClick={()=>setTab('roles')}>الأدوار والصلاحيات</button>
          <button className={tab==='structure'?'active':''} onClick={()=>setTab('structure')}>الهيكل التنظيمي</button>
        </div>
        {tab==='users'&&<input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث عن موظف أو دور"/>}
      </div>
      {tab==='users'?<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>الموظف</th><th>القسم</th><th>الدور</th><th>المدير المباشر</th><th>الحالة</th></tr></thead>
        <tbody>{shown.map(employee=><tr key={employee.id}>
          <td><b>{employee.name}</b><small>{employee.email||employee.phone||'لا توجد وسيلة تواصل'}</small></td>
          <td>{employee.department||'غير محدد'}</td><td>{employee.role||'غير محدد'}</td>
          <td>{employee.managerName||'—'}</td>
          <td><span className={employee.status==='active'?'mt-status active':'mt-status'}>{employee.status==='active'?'نشط':employee.status}</span></td>
        </tr>)}</tbody>
      </table>{!shown.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}</div>:tab==='roles'?<div className="mt-role-cards">
        {roles.map(role=><article key={role.id}><header><div><b>{role.nameAr}</b><small>{role.key}</small></div><span className="mt-status active">مفعّل</span></header><p>{(role.permissions||[]).join('، ')||'لم تُحدد صلاحيات تفصيلية لهذا الدور.'}</p></article>)}
        {!roles.length&&<div className="mt-empty">لم تُضبط أدوار المنشأة بعد.</div>}
      </div>:<div className="mt-department-grid">
        {departments.map(department=><article key={department.id}><span>{department.nameAr?.[0]||'ق'}</span><div><b>{department.nameAr}</b><small>{employees.filter(item=>item.department===department.nameAr).length} موظفين</small></div></article>)}
        {!departments.length&&<div className="mt-empty">لم يُنشأ الهيكل التنظيمي بعد.</div>}
      </div>}
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createEmployee}>
        <header><h3>إضافة موظف إلى المنشأة</h3><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">اسم الموظف<input name="full_name" required/></label>
          <label className="mt-field">البريد<input name="email" type="email"/></label>
          <label className="mt-field">الجوال<input name="phone"/></label>
          <label className="mt-field">القسم<select name="department_id"><option value="">اختر القسم</option>{departments.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">الدور الوظيفي<select name="job_role_id"><option value="">اختر الدور</option>{roles.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">المدير المباشر<select name="manager_employee_id"><option value="">بدون مدير</option>{employees.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">السعة الأسبوعية بالدقائق<input name="capacity_minutes_weekly" type="number" min="0" defaultValue="2400"/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ الموظف'}</button></footer>
      </form>
    </div>}
  </>;
}
