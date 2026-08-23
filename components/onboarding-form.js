'use client';

import Link from 'next/link';
import {useState} from 'react';
import {useRouter} from 'next/navigation';

export default function OnboardingForm({plans=[]}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [created,setCreated]=useState(null);
  const router=useRouter();

  async function submit(event){
    event.preventDefault();
    setBusy(true);setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const response=await fetch('/api/platform/provision-tenant',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        p_display_name:values.display_name,
        p_legal_name:values.legal_name||values.display_name,
        p_slug:values.slug,
        p_country_code:values.country_code,
        p_timezone:values.timezone,
        p_plan_key:values.plan_key||'free',
        p_owner_name:values.owner_name,
        p_owner_email:values.owner_email,
        p_hostname:normalizeHostname(values.hostname)
      })
    });
    const data=await response.json();
    setBusy(false);
    if(!response.ok){
      setError(data.error||'تعذر إنشاء المنشأة');
      return;
    }
    const token=data.data.owner?.invitationToken;
    setCreated({
      ...data.data,
      invitationUrl:token
        ?`${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`
        :null
    });
    router.refresh();
  }

  if(created)return <section className="provision-form provision-complete">
    <div className="form-success">اكتمل إنشاء المنشأة وربط الباقة والمالك والدومين بنجاح.</div>
    <div><b>المنشأة</b><span>{created.slug}</span></div>
    <div><b>المالك</b><span>{created.owner?.email}</span></div>
    <div><b>الحالة</b><span>{created.owner?.status==='linked'?'مرتبط بحسابه':'بانتظار التفعيل'}</span></div>
    {created.invitationUrl&&<button type="button" onClick={()=>navigator.clipboard.writeText(created.invitationUrl)}>نسخ رابط تفعيل المالك</button>}
    <Link className="mt-button primary" href={`/tenant/${created.slug}`}>فتح منصة المنشأة</Link>
  </section>;

  return <form className="provision-form" onSubmit={submit}>
    <label>اسم المنشأة<input name="display_name" required/></label>
    <label>الاسم القانوني<input name="legal_name"/></label>
    <label>الرابط المختصر<input name="slug" pattern="[a-z0-9-]+" placeholder="example-institute" required/></label>
    <label>الدومين أو Subdomain<input name="hostname" placeholder="example.odeir.com"/></label>
    <label>اسم مالك المنشأة<input name="owner_name" required/></label>
    <label>بريد مالك المنشأة<input name="owner_email" type="email" required/></label>
    <label>الدولة<select name="country_code"><option value="SA">السعودية</option><option value="AE">الإمارات</option><option value="EG">مصر</option></select></label>
    <label>المنطقة الزمنية<select name="timezone"><option value="Asia/Riyadh">الرياض</option><option value="Asia/Dubai">دبي</option><option value="Africa/Cairo">القاهرة</option></select></label>
    <label>الباقة<select name="plan_key" defaultValue="free">{plans.map(plan=><option key={plan.key} value={plan.key}>{plan.nameAr}</option>)}</select></label>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={busy}>{busy?'جارٍ إنشاء وربط المنصة…':'إنشاء المنشأة وتشغيلها'}</button>
  </form>;
}

function normalizeHostname(value){
  return String(value||'').trim().toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/\/.*$/,'')
    .replace(/\.$/,'')||null;
}
