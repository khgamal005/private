'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const money=value=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:0}).format((Number(value)||0)/100);

export default function PlatformTenants({initialData}){
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const tenants=initialData.tenants||[];
  const plans=initialData.plans||[];
  const shown=useMemo(()=>tenants.filter(tenant=>
    (status==='all'||tenant.status===status)&&
    `${tenant.name||''} ${tenant.slug||''} ${tenant.tenantKey||''}`.toLowerCase().includes(query.toLowerCase())
  ),[tenants,query,status]);

  async function call(action,body){
    const response=await fetch(`/api/platform/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }
  async function updateStatus(tenantId,value){
    setBusy(true);setError('');
    try{await call('set-tenant-status',{p_tenant_id:tenantId,p_status:value});setMessage('تم تحديث حالة المنشأة');router.refresh()}
    catch(err){setError(err.message)}finally{setBusy(false)}
  }
  async function updatePlan(tenantId,planKey){
    setBusy(true);setError('');
    try{await call('set-subscription',{p_tenant_id:tenantId,p_plan_key:planKey||'free'});setMessage('تم تحديث اشتراك المنشأة');router.refresh()}
    catch(err){setError(err.message)}finally{setBusy(false)}
  }
  async function createTenant(event){
    event.preventDefault();setBusy(true);setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await call('provision-tenant',{
        p_display_name:values.display_name,p_legal_name:values.legal_name||values.display_name,
        p_slug:values.slug,p_country_code:values.country_code,p_timezone:values.timezone,
        p_plan_key:values.plan_key||null
      });
      setMessage('تم إنشاء المنشأة ومساحتها المستقلة');setModal(false);router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head"><div><small>TENANTS</small><h2>المنشآت</h2><p>إدارة كل مساحة مستقلة وحالتها وباقتها دون خلط بياناتها.</p></div><div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ إنشاء منشأة</button></div></header>
    {message&&<div className="mt-alert">{message}</div>}{error&&!modal&&<div className="mt-alert error">{error}</div>}
    <section className="mt-kpis">
      <article className="mt-kpi"><span>كل المنشآت</span><b>{tenants.length}</b><small>مساحات مستقلة</small></article>
      <article className="mt-kpi"><span>النشطة</span><b>{tenants.filter(item=>item.status==='active').length}</b><small>تعمل بصورة طبيعية</small></article>
      <article className="mt-kpi"><span>التجريبية</span><b>{tenants.filter(item=>item.status==='trial').length}</b><small>في مرحلة التجربة</small></article>
      <article className="mt-kpi"><span>قيمة المسارات</span><b>{money(tenants.reduce((sum,item)=>sum+Number(item.pipelineValueMinor||0),0))}</b><small>داخل كل المنشآت</small></article>
    </section>
    <section className="mt-panel">
      <div className="mt-toolbar"><input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث باسم المنشأة أو الرابط"/><div className="mt-segmented"><button className={status==='all'?'active':''} onClick={()=>setStatus('all')}>الكل</button><button className={status==='active'?'active':''} onClick={()=>setStatus('active')}>نشطة</button><button className={status==='trial'?'active':''} onClick={()=>setStatus('trial')}>تجريبية</button></div></div>
      <div className="mt-table-wrap"><table className="mt-table"><thead><tr><th>المنشأة</th><th>التشغيل</th><th>المبيعات</th><th>الحالة</th><th>الباقة</th><th></th></tr></thead><tbody>
        {shown.map(tenant=><tr key={tenant.id}>
          <td><b>{tenant.name}</b><small>{tenant.slug} · {tenant.tenantKey}</small></td>
          <td><b>{tenant.employees||0} موظفين</b><small>{tenant.services||0} خدمات · {tenant.openTasks||0} مهام</small></td>
          <td><b>{money(tenant.pipelineValueMinor)}</b><small className={tenant.overdueTasks?'danger-text':''}>{tenant.overdueTasks||0} مهمة متأخرة</small></td>
          <td><select value={tenant.status} disabled={busy} onChange={event=>updateStatus(tenant.id,event.target.value)}><option value="active">نشطة</option><option value="trial">تجريبية</option><option value="suspended">موقوفة</option><option value="migrating">قيد النقل</option><option value="closed">مغلقة</option></select></td>
          <td><select value={tenant.planKey||''} disabled={busy} onChange={event=>updatePlan(tenant.id,event.target.value)}><option value="">بدون باقة</option>{plans.map(plan=><option value={plan.key} key={plan.key}>{plan.nameAr}</option>)}</select></td>
          <td><Link className="mt-button soft" href={`/tenant/${tenant.slug}`}>فتح</Link></td>
        </tr>)}
      </tbody></table>{!shown.length&&<div className="mt-empty">لا توجد منشآت مطابقة.</div>}</div>
    </section>
    {modal&&<div className="mt-modal-layer"><button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/><form className="mt-modal" onSubmit={createTenant}>
      <header><h3>إنشاء منشأة جديدة</h3><button type="button" onClick={()=>setModal(false)}>×</button></header>
      <div className="mt-form">
        <label className="mt-field">اسم المنشأة<input name="display_name" required/></label><label className="mt-field">الاسم القانوني<input name="legal_name"/></label>
        <label className="mt-field">الرابط المختصر<input name="slug" required pattern="[a-z0-9-]+"/></label><label className="mt-field">الدولة<select name="country_code" defaultValue="SA"><option value="SA">السعودية</option><option value="EG">مصر</option><option value="AE">الإمارات</option></select></label>
        <label className="mt-field">المنطقة الزمنية<select name="timezone" defaultValue="Asia/Riyadh"><option value="Asia/Riyadh">الرياض</option><option value="Africa/Cairo">القاهرة</option><option value="Asia/Dubai">دبي</option></select></label>
        <label className="mt-field">الباقة<select name="plan_key"><option value="">بدون باقة</option>{plans.map(plan=><option value={plan.key} key={plan.key}>{plan.nameAr}</option>)}</select></label>
        {error&&<div className="mt-alert error mt-field wide">{error}</div>}
      </div>
      <footer><button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الإنشاء…':'إنشاء المنشأة'}</button></footer>
    </form></div>}
  </>;
}
