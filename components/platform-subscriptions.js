'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-commerce.module.css';

const EMPTY=[];
const STATUS={active:'نشط',trialing:'تجريبي',past_due:'متأخر السداد',paused:'موقوف',cancelled:'ملغي'};
const date=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeZone:'Asia/Riyadh'}).format(new Date(value)):'—';
const today=()=>new Date().toISOString().slice(0,10);

export default function PlatformSubscriptions({initialData}){
  const router=useRouter();
  const subscriptions=initialData?.subscriptions||EMPTY;
  const plans=[...(initialData?.plans||EMPTY),...(initialData?.adminOnlyPlans||EMPTY)].filter(plan=>plan.status==='active');
  const tenants=initialData?.tenants||EMPTY;
  const [filter,setFilter]=useState('current');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const summary=initialData?.summary||{};
  const rows=useMemo(()=>{const needle=query.trim().toLocaleLowerCase('ar');return subscriptions.filter(item=>{
    const statusMatch=filter==='all'||(filter==='current'&&['active','trialing','past_due','paused'].includes(item.status))||item.status===filter;
    const searchMatch=!needle||[item.tenantName,item.tenantSlug,item.planName,item.status].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle));
    return statusMatch&&searchMatch;
  })},[subscriptions,filter,query]);

  async function save(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/platform/commerce',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_action:'set_subscription',p_payload:{
        tenantId:values.tenant_id,planId:values.plan_id,status:values.status,
        periodStart:`${values.period_start}T00:00:00+03:00`,billingInterval:values.billing_interval
      }})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'تعذر حفظ الاشتراك');
      setModal(false);setNotice('تم تحديث اشتراك المنشأة دون حذف أي بيانات أو إضافات سابقة.');router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر حفظ الاشتراك')}finally{setBusy(false)}
  }

  return <section className={styles.page}>
    <header className={styles.hero}><div><small>SUBSCRIPTION OPERATIONS</small><h1>اشتراكات المنشآت</h1><p>متابعة دورة حياة كل اشتراك، وتحويل التجارب إلى باقات مدفوعة، ومعالجة التأخر أو الإيقاف دون المساس ببيانات المنشأة.</p></div><div className={styles.heroActions}><button className={styles.primary} onClick={()=>setModal(true)}>+ تعيين اشتراك</button></div></header>
    <section className={styles.kpis}>
      <article><span>نشطة</span><b>{summary.activeSubscriptions||0}</b><small>تعمل الآن</small></article>
      <article><span>تجريبية</span><b>{summary.trialSubscriptions||0}</b><small>قابلة للتحويل</small></article>
      <article className={summary.pastDueSubscriptions?styles.warning:''}><span>متأخرة السداد</span><b>{summary.pastDueSubscriptions||0}</b><small>تحتاج متابعة</small></article>
      <article><span>إجمالي السجلات</span><b>{subscriptions.length}</b><small>يشمل التاريخ السابق</small></article>
    </section>
    {notice&&<div className={styles.notice}>{notice}</div>}{error&&<div className={styles.error}>{error}</div>}
    <div className={styles.toolbar}><div className={styles.filters}>{[['current','الحالية'],['active','النشطة'],['trialing','التجريبية'],['past_due','متأخرة السداد'],['all','الكل']].map(([key,label])=><button key={key} className={filter===key?styles.active:''} onClick={()=>setFilter(key)}>{label}</button>)}</div><input className={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالمنشأة أو الباقة…"/></div>
    <section className={styles.panel}><header className={styles.panelHeader}><div><h2>سجل الاشتراكات</h2><p>{rows.length} اشتراكًا مطابقًا</p></div></header><div className={styles.table}>
      <div className={styles.tableHeader}><span>المنشأة</span><span>الباقة</span><span>الحالة</span><span>الفترة</span><span>ملاحظة</span></div>
      {rows.map(item=><div className={styles.tableRow} key={item.id}><div><b>{item.tenantName}</b><small>{item.tenantSlug}</small></div><div><b>{item.planName}</b><small>{item.planKey}</small></div><span className={`${styles.status} ${styles[item.status]||''}`}>{STATUS[item.status]||item.status}</span><div><b>{date(item.periodEnd)}</b><small>بدأ {date(item.periodStart)}</small></div><div><small>{item.tenantSlug==='reef-skills'?'عقد النسخة الكاملة محفوظ':item.cancelAtPeriodEnd?'يتوقف بنهاية الفترة':item.billingInterval==='year'?'سنوي':item.billingInterval==='month'?'شهري':'عقد سابق'}</small></div></div>)}
      {!rows.length&&<div className={styles.empty}>لا توجد اشتراكات مطابقة.</div>}
    </div></section>
    {modal&&<div className={styles.modalLayer}><button className={styles.backdrop} aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/><form className={styles.modal} onSubmit={save}><header><div><h2>تعيين باقة لمنشأة</h2><p>يُغلق الاشتراك الحالي كسجل تاريخي ويبدأ اشتراك جديد.</p></div><button type="button" className={styles.close} onClick={()=>setModal(false)}>×</button></header><div className={styles.form}>
      <label className={`${styles.field} ${styles.wide}`}>المنشأة<select name="tenant_id" required defaultValue=""><option value="" disabled>اختر المنشأة بالاسم والرابط</option>{tenants.filter(tenant=>tenant.slug!=='reef-skills').map(tenant=><option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.slug}</option>)}</select></label>
      <label className={styles.field}>الباقة<select name="plan_id" required>{plans.map(plan=><option key={plan.id} value={plan.id}>{plan.nameAr}</option>)}</select></label>
      <label className={styles.field}>الحالة<select name="status"><option value="active">نشط</option><option value="trialing">تجريبي</option><option value="paused">موقوف</option><option value="past_due">متأخر السداد</option></select></label>
      <label className={styles.field}>بداية الفترة<input name="period_start" type="date" defaultValue={today()} required/></label>
      <label className={styles.field}>مدة الاشتراك<select name="billing_interval" defaultValue="month"><option value="month">شهري</option><option value="year">سنوي — 12 شهرًا بسعر 10</option></select></label>
      <aside className={styles.hint}>ينتهي الاشتراك المدفوع بعد المدة المختارة، والمجانية والكاملة دون انتهاء. الإضافات مستقلة ولا تتغير. ريف مستثناة ومحفوظة على النسخة الكاملة؛ هذا الإجراء ليس إثبات تحصيل مالي.</aside>
      <footer className={styles.formFooter}><button type="button" className={styles.ghost} onClick={()=>setModal(false)}>إلغاء</button><button className={styles.secondary} disabled={busy||!tenants.length||!plans.length}>{busy?'جارٍ الحفظ…':'تعيين الاشتراك'}</button></footer>
    </div></form></div>}
  </section>;
}
