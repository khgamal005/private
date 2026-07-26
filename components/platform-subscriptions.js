'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

const money=value=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:0}).format((Number(value)||0)/100);
const date=value=>value?new Date(value).toLocaleDateString('ar-SA'):'—';

export default function PlatformSubscriptions({initialData}){
  const router=useRouter();
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const plans=initialData.plans||[];
  const subscriptions=initialData.subscriptions||[];
  async function createPlan(event){
    event.preventDefault();setBusy(true);setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/platform/create-plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        p_plan_key:values.plan_key,p_name_ar:values.name_ar,p_name_en:values.name_en||null,
        p_amount_minor:Math.round(Number(values.amount||0)*100),p_interval:values.interval
      })});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error||'تعذر إنشاء الباقة');
      setMessage('تم إنشاء الباقة');setModal(false);router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }
  return <>
    <header className="mt-page-head"><div><small>PLANS & BILLING</small><h2>الباقات والاشتراكات</h2><p>تعريف الباقات ومتابعة اشتراك كل منشأة بصورة مستقلة.</p></div><div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ باقة جديدة</button></div></header>
    {message&&<div className="mt-alert">{message}</div>}
    <section className="mt-plan-grid">{plans.map(plan=><article key={plan.key}><small>{plan.interval==='month'?'شهري':plan.interval==='year'?'سنوي':plan.interval}</small><h3>{plan.nameAr}</h3><b>{plan.amountMinor?money(plan.amountMinor):'مجانية'}</b><span className={`mt-status ${plan.status==='active'?'active':''}`}>{plan.status}</span></article>)}
      {!plans.length&&<div className="mt-panel mt-empty">لا توجد باقات معرفة.</div>}
    </section>
    <section className="mt-panel"><header className="mt-panel-head"><div><h3>الاشتراكات الحالية</h3><p>{subscriptions.length} اشتراكًا</p></div></header><div className="mt-table-wrap"><table className="mt-table"><thead><tr><th>المنشأة</th><th>الباقة</th><th>الحالة</th><th>نهاية الفترة</th></tr></thead><tbody>{subscriptions.map(item=><tr key={item.id}><td><b>{item.tenantName}</b></td><td>{item.planName}</td><td><span className={`mt-status ${item.status==='active'?'active':''}`}>{item.status}</span></td><td>{date(item.periodEnd)}</td></tr>)}</tbody></table></div></section>
    {modal&&<div className="mt-modal-layer"><button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/><form className="mt-modal" onSubmit={createPlan}><header><h3>إنشاء باقة اشتراك</h3><button type="button" onClick={()=>setModal(false)}>×</button></header><div className="mt-form">
      <label className="mt-field">مفتاح الباقة<input name="plan_key" required pattern="[a-z0-9_]+"/></label><label className="mt-field">الاسم العربي<input name="name_ar" required/></label>
      <label className="mt-field">الاسم الإنجليزي<input name="name_en"/></label><label className="mt-field">السعر بالريال<input name="amount" type="number" min="0" step=".01"/></label>
      <label className="mt-field">الفترة<select name="interval"><option value="month">شهري</option><option value="year">سنوي</option><option value="one_time">مرة واحدة</option></select></label>
      {error&&<div className="mt-alert error mt-field wide">{error}</div>}
    </div><footer><button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ الباقة'}</button></footer></form></div>}
  </>;
}
