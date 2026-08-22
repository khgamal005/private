'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',currency:'SAR',maximumFractionDigits:0
}).format((Number(value)||0)/100);

export default function PlatformTenants({initialData}){
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [provisioned,setProvisioned]=useState(null);
  const tenants=useMemo(()=>initialData.tenants||[],[initialData.tenants]);
  const plans=initialData.plans||[];
  const shown=useMemo(()=>tenants.filter(tenant=>
    (status==='all'||tenant.status===status)&&
    `${tenant.name||''} ${tenant.slug||''} ${tenant.tenantKey||''} ${tenant.ownerEmail||''} ${tenant.domain||''}`
      .toLowerCase().includes(query.toLowerCase())
  ),[tenants,query,status]);

  async function call(action,body){
    const response=await fetch(`/api/platform/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }

  async function updateStatus(tenantId,value){
    setBusy(true);setError('');
    try{
      await call('set-tenant-status',{p_tenant_id:tenantId,p_status:value});
      setMessage('تم تحديث حالة المنشأة');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function updatePlan(tenantId,planKey){
    setBusy(true);setError('');
    try{
      await call('set-subscription',{p_tenant_id:tenantId,p_plan_key:planKey||'free'});
      setMessage('تم تحديث اشتراك المنشأة');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function createTenant(event){
    event.preventDefault();
    setBusy(true);setError('');setProvisioned(null);
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const created=await call('provision-tenant',{
        p_display_name:values.display_name,
        p_legal_name:values.legal_name||values.display_name,
        p_slug:values.slug,
        p_country_code:values.country_code,
        p_timezone:values.timezone,
        p_plan_key:values.plan_key||'free',
        p_owner_name:values.owner_name,
        p_owner_email:values.owner_email,
        p_hostname:normalizeHostname(values.hostname)
      });
      const token=created.owner?.invitationToken;
      setProvisioned({
        ...created,
        invitationUrl:token
          ?`${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`
          :null
      });
      setMessage('اكتملت دورة إنشاء المنشأة وربط الباقة والمالك والدومين');
      setModal(false);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function copyInvitation(){
    if(!provisioned?.invitationUrl)return;
    await navigator.clipboard.writeText(provisioned.invitationUrl);
    setMessage('تم نسخ رابط تفعيل مالك المنشأة');
  }

  return <>
    <header className="mt-page-head">
      <div><small>TENANTS</small><h2>المنشآت</h2><p>إنشاء وإدارة كل مساحة مع مالكها وباقتها ودومينها وعزل بياناتها.</p></div>
      <div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ إنشاء منشأة</button></div>
    </header>
    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    {provisioned&&<section className="mt-panel mt-provision-result">
      <header className="mt-panel-head">
        <div><h3>تم تجهيز {provisioned.slug}</h3><p>المنشأة والاشتراك والدومين والمالك أُنشئت في عملية واحدة.</p></div>
        <span className="mt-status active">جاهزة</span>
      </header>
      <div className="mt-panel-body mt-provision-grid">
        <div><span>مالك المنشأة</span><b>{provisioned.owner?.email}</b><small>{provisioned.owner?.status==='linked'?'مرتبط بحساب نشط':'دعوة التفعيل جاهزة'}</small></div>
        <div><span>الباقة</span><b>{provisioned.planKey}</b><small>حالة الاشتراك: تجريبي</small></div>
        <div><span>الدومين</span><b>{provisioned.domain?.hostname||'لم يضف'}</b><small>{provisioned.domain?'بانتظار التحقق':'يمكن إضافته لاحقًا'}</small></div>
        <div className="mt-page-actions">
          {provisioned.invitationUrl&&<button className="mt-button" onClick={copyInvitation}>نسخ رابط تفعيل المالك</button>}
          <Link className="mt-button primary" href={`/tenant/${provisioned.slug}`}>فتح المنصة</Link>
        </div>
      </div>
    </section>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>كل المنشآت</span><b>{tenants.length}</b><small>مساحات مستقلة</small></article>
      <article className="mt-kpi"><span>النشطة</span><b>{tenants.filter(item=>item.status==='active').length}</b><small>تعمل بصورة طبيعية</small></article>
      <article className="mt-kpi"><span>التجريبية</span><b>{tenants.filter(item=>item.status==='trial').length}</b><small>في مرحلة التجربة</small></article>
      <article className="mt-kpi"><span>دعوات معلقة</span><b>{initialData.pendingInvitations||0}</b><small>بانتظار تفعيل المستخدم</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالمنشأة أو المالك أو الدومين"/>
        <div className="mt-segmented">
          <button className={status==='all'?'active':''} onClick={()=>setStatus('all')}>الكل</button>
          <button className={status==='active'?'active':''} onClick={()=>setStatus('active')}>نشطة</button>
          <button className={status==='trial'?'active':''} onClick={()=>setStatus('trial')}>تجريبية</button>
        </div>
      </div>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>المنشأة</th><th>المالك</th><th>الدومين</th><th>المستخدمون</th><th>الحالة</th><th>الباقة</th><th></th></tr></thead>
        <tbody>{shown.map(tenant=><tr key={tenant.id}>
          <td><b>{tenant.name}</b><small>{tenant.slug} · {tenant.tenantKey}</small></td>
          <td><b>{tenant.ownerName||'لم يحدد'}</b><small>{tenant.ownerEmail||'—'} · {tenant.ownerStatus==='linked'?'مرتبط':'بانتظار التفعيل'}</small></td>
          <td><b>{tenant.domain||'بدون دومين'}</b><small>{domainStatus(tenant.domainStatus)}</small></td>
          <td><b>{tenant.employees||0} مستخدم</b><small>بحسابات وصلاحيات معزولة</small></td>
          <td><select value={tenant.status} disabled={busy} onChange={event=>updateStatus(tenant.id,event.target.value)}>
            <option value="active">نشطة</option><option value="trial">تجريبية</option><option value="suspended">موقوفة</option><option value="migrating">قيد النقل</option><option value="closed">مغلقة</option>
          </select></td>
          <td><select value={tenant.planKey||''} disabled={busy} onChange={event=>updatePlan(tenant.id,event.target.value)}>
            <option value="">بدون باقة</option>{plans.map(plan=><option value={plan.key} key={plan.key}>{plan.nameAr}</option>)}
          </select></td>
          <td><Link prefetch={false} className="mt-button soft" href={`/tenant/${tenant.slug}`}>فتح</Link></td>
        </tr>)}</tbody>
      </table>{!shown.length&&<div className="mt-empty">لا توجد منشآت مطابقة.</div>}</div>
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createTenant}>
        <header><div><small>دورة إنشاء كاملة</small><h3>إنشاء منشأة جديدة</h3></div><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field">اسم المنشأة<input name="display_name" required/></label>
          <label className="mt-field">الاسم القانوني<input name="legal_name"/></label>
          <label className="mt-field">الرابط المختصر<input name="slug" required pattern="[a-z0-9-]+" placeholder="reef-skills"/></label>
          <label className="mt-field">الدومين أو Subdomain<input name="hostname" placeholder="reef.marktone.sa"/></label>
          <label className="mt-field">اسم مالك المنشأة<input name="owner_name" required/></label>
          <label className="mt-field">بريد المالك<input name="owner_email" type="email" required/></label>
          <label className="mt-field">الدولة<select name="country_code" defaultValue="SA"><option value="SA">السعودية</option><option value="EG">مصر</option><option value="AE">الإمارات</option></select></label>
          <label className="mt-field">المنطقة الزمنية<select name="timezone" defaultValue="Asia/Riyadh"><option value="Asia/Riyadh">الرياض</option><option value="Africa/Cairo">القاهرة</option><option value="Asia/Dubai">دبي</option></select></label>
          <label className="mt-field wide">الباقة<select name="plan_key" defaultValue="free">{plans.map(plan=><option value={plan.key} key={plan.key}>{plan.nameAr}</option>)}</select></label>
          <div className="mt-alert mt-field wide">إذا كان البريد لديه حساب فسيُربط فورًا، وإلا سيظهر رابط تفعيل آمن لإرساله إلى المالك.</div>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ تجهيز المنصة…':'إنشاء وربط كل العناصر'}</button></footer>
      </form>
    </div>}
  </>;
}

function normalizeHostname(value){
  return String(value||'').trim().toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/\/.*$/,'')
    .replace(/\.$/,'')||null;
}

function domainStatus(value){
  return ({pending:'بانتظار التحقق',verifying:'جارٍ التحقق',active:'نشط',failed:'فشل التحقق',disabled:'معطل'})[value]||'غير مضاف';
}
