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
  const [invitationUrl,setInvitationUrl]=useState('');
  const users=useMemo(()=>initialData.employees||[],[initialData.employees]);
  const roles=initialData.roles||[];
  const invitations=initialData.invitations||[];
  const domains=initialData.domains||[];
  const shown=useMemo(()=>users.filter(user=>
    `${user.name||''} ${user.email||''} ${user.role||''}`.toLowerCase().includes(query.toLowerCase())
  ),[users,query]);

  async function inviteUser(event){
    event.preventDefault();
    setBusy(true);setError('');setInvitationUrl('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/platform/invite-user',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_full_name:values.full_name,
          p_email:values.email,
          p_role_key:values.role_key
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر دعوة المستخدم');
      if(payload.data.status==='linked'){
        setMessage('تم ربط المستخدم بحسابه الحالي وصلاحيات المنشأة');
        setModal(false);
      }else{
        const url=`${window.location.origin}/accept-invite?token=${encodeURIComponent(payload.data.invitationToken)}`;
        setInvitationUrl(url);
        setMessage('تم إنشاء دعوة المستخدم. انسخ الرابط وأرسله إلى البريد المحدد.');
      }
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function copyInvitation(){
    await navigator.clipboard.writeText(invitationUrl);
    setMessage('تم نسخ رابط التفعيل');
  }

  return <>
    <header className="mt-page-head">
      <div><small>TENANT ACCESS</small><h2>المستخدمون والصلاحيات</h2><p>حسابات حقيقية مرتبطة بالمنشأة، مع دور وصلاحيات مستقلة لكل مستخدم.</p></div>
      <div className="mt-page-actions"><button className="mt-button primary" onClick={()=>{setModal(true);setInvitationUrl('')}}>+ دعوة مستخدم</button></div>
    </header>
    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>المستخدمون المرتبطون</span><b>{users.length}</b><small>{users.filter(item=>item.status==='active').length} حسابًا نشطًا</small></article>
      <article className="mt-kpi"><span>الدعوات المعلقة</span><b>{invitations.filter(item=>item.status==='pending').length}</b><small>بانتظار قبول الدعوة</small></article>
      <article className="mt-kpi"><span>الأدوار المتاحة</span><b>{roles.length}</b><small>قوالب صلاحيات المنشأة</small></article>
      <article className="mt-kpi"><span>الدومين الأساسي</span><b className="mt-kpi-domain">{domains.find(item=>item.primary)?.hostname||'—'}</b><small>{domainStatus(domains.find(item=>item.primary)?.status)}</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={tab==='users'?'active':''} onClick={()=>setTab('users')}>المستخدمون</button>
          <button className={tab==='invitations'?'active':''} onClick={()=>setTab('invitations')}>الدعوات</button>
          <button className={tab==='roles'?'active':''} onClick={()=>setTab('roles')}>الأدوار والصلاحيات</button>
        </div>
        {tab==='users'&&<input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث عن مستخدم أو دور"/>}
      </div>

      {tab==='users'?<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>المستخدم</th><th>الدور</th><th>الصلاحيات</th><th>الحالة</th></tr></thead>
        <tbody>{shown.map(user=><tr key={user.id}>
          <td><b>{user.name}</b><small>{user.email}</small></td>
          <td>{user.role||'غير محدد'}</td>
          <td><small>{(user.permissions||[]).length} صلاحية</small></td>
          <td><span className={user.status==='active'?'mt-status active':'mt-status'}>{user.status==='active'?'نشط':user.status}</span></td>
        </tr>)}</tbody>
      </table>{!shown.length&&<div className="mt-empty">لا توجد حسابات مرتبطة بعد.</div>}</div>
      :tab==='invitations'?<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>المستخدم</th><th>الدور</th><th>الحالة</th><th>تنتهي في</th></tr></thead>
        <tbody>{invitations.map(invitation=><tr key={invitation.id}>
          <td><b>{invitation.fullName}</b><small>{invitation.email}</small></td>
          <td>{roles.find(role=>role.key===invitation.roleKey)?.nameAr||invitation.roleKey}</td>
          <td><span className={invitation.status==='accepted'?'mt-status active':'mt-status'}>{invitationStatus(invitation.status)}</span></td>
          <td>{new Date(invitation.expiresAt).toLocaleDateString('ar-SA')}</td>
        </tr>)}</tbody>
      </table>{!invitations.length&&<div className="mt-empty">لا توجد دعوات حتى الآن.</div>}</div>
      :<div className="mt-role-cards">
        {roles.map(role=><article key={role.id}>
          <header><div><b>{role.nameAr}</b><small>{role.key}</small></div><span className="mt-status active">مفعّل</span></header>
          <p>{(role.permissions||[]).join('، ')||'لم تُحدد صلاحيات تفصيلية لهذا الدور.'}</p>
        </article>)}
        {!roles.length&&<div className="mt-empty">لم تُضبط أدوار المنشأة بعد.</div>}
      </div>}
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={inviteUser}>
        <header><div><small>USER ACCESS</small><h3>دعوة مستخدم إلى المنشأة</h3></div><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">اسم المستخدم<input name="full_name" required/></label>
          <label className="mt-field">البريد الإلكتروني<input name="email" type="email" required/></label>
          <label className="mt-field">الدور<select name="role_key" defaultValue="tenant_admin">{roles.map(role=><option value={role.key} key={role.key}>{role.nameAr}</option>)}</select></label>
          {invitationUrl&&<div className="mt-invitation-link mt-field wide">
            <span>رابط التفعيل يظهر مرة واحدة</span>
            <input readOnly value={invitationUrl}/>
            <button type="button" className="mt-button" onClick={copyInvitation}>نسخ الرابط</button>
          </div>}
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={()=>setModal(false)}>إغلاق</button>
          {!invitationUrl&&<button className="mt-button primary" disabled={busy}>{busy?'جارٍ إنشاء الدعوة…':'دعوة وربط الصلاحيات'}</button>}
        </footer>
      </form>
    </div>}
  </>;
}

function invitationStatus(value){
  return ({pending:'بانتظار القبول',accepted:'مقبولة',revoked:'ملغاة',expired:'منتهية'})[value]||value;
}

function domainStatus(value){
  return ({pending:'بانتظار التحقق',verifying:'جارٍ التحقق',active:'نشط',failed:'فشل التحقق',disabled:'معطل'})[value]||'لم يضف';
}
