'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import TenantDeletionDialog from './tenant-deletion-dialog';
import PlatformTenantControls from './platform-tenant-controls';
import PlatformAcademyControls from './platform-academy-controls';

export default function PlatformTenants({initialData}){
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [provisioned,setProvisioned]=useState(null);
  const [deletionTenant,setDeletionTenant]=useState(null);
  const [controlTenant,setControlTenant]=useState(null);
  const [academyTenant,setAcademyTenant]=useState(null);
  const [tenantUpdates,setTenantUpdates]=useState({});
  const [deletedIds,setDeletedIds]=useState(()=>new Set());
  const [odeiryStates,setOdeiryStates]=useState({});
  const [odeiryBusySlug,setOdeiryBusySlug]=useState('');
  const [odeiryConfirmation,setOdeiryConfirmation]=useState(null);
  const tenants=useMemo(()=>(initialData.tenants||[]).filter(
    tenant=>!deletedIds.has(tenant.id)
  ).map(tenant=>({...tenant,...tenantUpdates[tenant.id]})),[initialData.tenants,deletedIds,tenantUpdates]);
  const plans=initialData.plans||[];
  const odeiryControl=initialData.odeiryManager||{};
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

  function odeiryState(tenant){
    return odeiryStates[tenant.slug]||tenant.odeiryManager||{
      enabled:false,effectiveEnabled:false,version:0
    };
  }

  async function configureOdeiryManager(){
    const request=odeiryConfirmation;
    if(!request||odeiryBusySlug)return;
    const current=odeiryState(request.tenant);
    setOdeiryBusySlug(request.tenant.slug);
    setError('');
    setMessage('');
    try{
      const updated=await call('configure-odeiry-manager',{
        p_slug:request.tenant.slug,
        p_payload:{
          enabled:request.enabled,
          expectedVersion:current.version
        }
      });
      setOdeiryStates(states=>({
        ...states,
        [request.tenant.slug]:{
          enabled:Boolean(updated.enabled),
          effectiveEnabled:Boolean(updated.effectiveEnabled),
          version:Number(updated.version)||0
        }
      }));
      setMessage(
        `${request.enabled?'تم تفعيل':'تم إيقاف'} أوديري المدير لمنشأة ${request.tenant.name}`
      );
      setOdeiryConfirmation(null);
      router.refresh();
    }catch(err){
      setError(err.message);
      setOdeiryConfirmation(null);
    }finally{
      setOdeiryBusySlug('');
    }
  }

  function controlsChanged(data){
    setTenantUpdates(current=>({...current,[data.tenant.id]:{
      status:data.tenant.status,planKey:data.subscription?.planKey||'',
      planName:data.subscription?.planName||'بدون باقة'
    }}));
    router.refresh();
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

  function deletionCompleted(result){
    const deletedId=String(result?.tenantId||deletionTenant?.id||'');
    setDeletedIds(current=>new Set([...current,deletedId]));
    setDeletionTenant(null);
    setError('');
    setMessage('تم حذف المنشأة نهائيًا وتحرير بياناتها لإعادة التسجيل من الصفر.');
    router.refresh();
  }

  return <>
    <header className="mt-page-head">
      <div><small>TENANTS</small><h2>المنشآت</h2><p>إنشاء وإدارة كل مساحة مع مالكها وباقتها ودومينها وعزل بياناتها.</p></div>
      <div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ إنشاء منشأة</button></div>
    </header>
    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}
    {!odeiryControl.globalEnabled&&<div className="mt-alert error">
      البوابة العامة لأوديري المدير متوقفة؛ يمكنك حفظ حالة كل منشأة، لكنها لن تصبح فعالة قبل تشغيل البوابة العامة.
    </div>}

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
      <article className="mt-kpi"><span>أوديري المدير</span><b>{tenants.filter(item=>odeiryState(item).enabled).length}</b><small>منشآت مفعّل لها</small></article>
      <article className="mt-kpi"><span>دعوات معلقة</span><b>{initialData.pendingInvitations||0}</b><small>بانتظار تفعيل المستخدم</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالمنشأة أو المالك أو الدومين"/>
        <div className="mt-segmented">
          <button className={status==='all'?'active':''} onClick={()=>setStatus('all')}>الكل</button>
          <button className={status==='active'?'active':''} onClick={()=>setStatus('active')}>نشطة</button>
          <button className={status==='trial'?'active':''} onClick={()=>setStatus('trial')}>تجريبية</button>
          <button className={status==='suspended'?'active':''} onClick={()=>setStatus('suspended')}>موقوفة</button>
          <button className={status==='closed'?'active':''} onClick={()=>setStatus('closed')}>مغلقة</button>
        </div>
      </div>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>المنشأة</th><th>المالك</th><th>الدومين</th><th>المستخدمون</th><th>الحالة</th><th>الباقة</th><th>أوديري المدير</th><th>الإجراءات</th></tr></thead>
        <tbody>{shown.map(tenant=>{
          const manager=odeiryState(tenant);
          const managerBusy=odeiryBusySlug===tenant.slug;
          return <tr key={tenant.id}>
            <td><b>{tenant.name}</b><small>{tenant.slug} · {tenant.tenantKey}</small></td>
            <td><b>{tenant.ownerName||'لم يحدد'}</b><small>{tenant.ownerEmail||'—'} · {tenant.ownerStatus==='linked'?'مرتبط':'بانتظار التفعيل'}</small></td>
            <td><b>{tenant.domain||'بدون دومين'}</b><small>{domainStatus(tenant.domainStatus)}</small></td>
            <td><b>{tenant.employees||0} مستخدم</b><small>بحسابات وصلاحيات معزولة</small></td>
            <td><span className={`mt-status ${tenant.status}`}>{tenantStatus(tenant.status)}</span></td>
            <td><b>{tenant.planName||plans.find(plan=>plan.key===tenant.planKey)?.nameAr||'بدون باقة'}</b>
              {tenant.slug==='reef-skills'&&<small>عقد محفوظ ومحمي</small>}
            </td>
            <td><button
              type="button"
              className={`mt-button ${manager.enabled?'primary':'soft'}`}
              aria-pressed={manager.enabled}
              disabled={!odeiryControl.canManage||managerBusy}
              title={!odeiryControl.canManage?'تحتاج صلاحية إدارة إعدادات المنصة':undefined}
              onClick={()=>setOdeiryConfirmation({tenant,enabled:!manager.enabled})}
            >{managerBusy?'جارٍ الحفظ…':manager.enabled?'مفعّل':'متوقف'}</button>
            <small>{manager.effectiveEnabled?'متاح داخل المنشأة':manager.enabled?'بانتظار البوابة العامة':'لا يظهر للمديرين'}</small></td>
            <td><div className="mt-tenant-row-actions">
              <button type="button" className="mt-button primary" disabled={busy} onClick={()=>setControlTenant(tenant)} aria-label={`إدارة ${tenant.name}`}>إدارة المنشأة</button>
              <button type="button" className="mt-button soft" disabled={busy} onClick={()=>setAcademyTenant(tenant)}>المنصة التدريبية</button>
              <Link prefetch={false} className="mt-button soft" href={`/tenant/${tenant.slug}`}>فتح</Link>
              <button type="button" className="mt-button danger-outline" disabled={busy||tenant.slug==='reef-skills'||!initialData.adminPermissions?.canDelete} onClick={()=>setDeletionTenant({id:tenant.id,name:tenant.name,slug:tenant.slug})}>حذف نهائي</button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>{!shown.length&&<div className="mt-empty">لا توجد منشآت مطابقة.</div>}</div>
    </section>

    {academyTenant&&<PlatformAcademyControls tenant={academyTenant} onClose={()=>setAcademyTenant(null)}/>}
    {controlTenant&&<PlatformTenantControls
      tenant={controlTenant}
      onClose={()=>setControlTenant(null)}
      onChanged={controlsChanged}
      onDelete={tenant=>{setControlTenant(null);setDeletionTenant(tenant);}}
    />}

    {odeiryConfirmation&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!odeiryBusySlug&&setOdeiryConfirmation(null)}/>
      <section className="mt-modal" role="dialog" aria-modal="true" aria-labelledby="odeiry-confirmation-title">
        <header><div><small>تأكيد تغيير الإتاحة</small><h3 id="odeiry-confirmation-title">{odeiryConfirmation.enabled?'تفعيل':'إيقاف'} أوديري المدير</h3></div><button type="button" disabled={Boolean(odeiryBusySlug)} onClick={()=>setOdeiryConfirmation(null)}>×</button></header>
        <div className="mt-form">
          <div className="mt-alert mt-field wide">
            سيتم {odeiryConfirmation.enabled?'تفعيل':'إيقاف'} أوديري المدير لمنشأة <b>{odeiryConfirmation.tenant.name}</b> فقط. لن ينفذ أوديري أي تعديل على بيانات المنشأة.
          </div>
        </div>
        <footer><button type="button" className="mt-button" disabled={Boolean(odeiryBusySlug)} onClick={()=>setOdeiryConfirmation(null)}>إلغاء</button><button type="button" className={`mt-button ${odeiryConfirmation.enabled?'primary':'danger-outline'}`} disabled={Boolean(odeiryBusySlug)} onClick={configureOdeiryManager}>{odeiryBusySlug?'جارٍ الحفظ…':'تأكيد'}</button></footer>
      </section>
    </div>}

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createTenant}>
        <header><div><small>دورة إنشاء كاملة</small><h3>إنشاء منشأة جديدة</h3></div><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field">اسم المنشأة<input name="display_name" required/></label>
          <label className="mt-field">الاسم القانوني<input name="legal_name"/></label>
          <label className="mt-field">الرابط المختصر<input name="slug" required pattern="[a-z0-9-]+" placeholder="training-center"/></label>
          <label className="mt-field">الدومين أو Subdomain<input name="hostname" placeholder="training-center.odeir.com"/></label>
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
    {deletionTenant&&<TenantDeletionDialog
      tenant={deletionTenant}
      onClose={()=>setDeletionTenant(null)}
      onDeleted={deletionCompleted}
    />}
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

function tenantStatus(value){
  return {active:'نشطة',trial:'تجريبية',suspended:'موقوفة',closed:'مغلقة',migrating:'قيد النقل'}[value]||value;
}
