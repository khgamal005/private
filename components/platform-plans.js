'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-commerce.module.css';

const EMPTY=[];
const money=(minor,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency,maximumFractionDigits:0}).format((Number(minor)||0)/100);
const intervalLabel={month:'شهريًا',year:'سنويًا',one_time:'مرة واحدة'};

export default function PlatformPlans({initialData}){
  const router=useRouter();
  const plans=initialData?.plans||EMPTY;
  const definitions=initialData?.limitDefinitions||EMPTY;
  const [editing,setEditing]=useState(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const summary=initialData?.summary||{};
  const activePlans=useMemo(()=>plans.filter(plan=>plan.status!=='archived'),[plans]);

  async function commerce(action,payload){
    const response=await fetch('/api/platform/commerce',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر حفظ الباقة');
    return result.data;
  }

  async function save(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    const form=new FormData(event.currentTarget);
    try{
      const plan=await commerce('save_plan',{
        planId:editing?.id||null,planKey:form.get('plan_key'),nameAr:form.get('name_ar'),nameEn:form.get('name_en'),
        description:form.get('description'),amountMinor:Math.round(Number(form.get('amount')||0)*100),currency:form.get('currency'),
        interval:form.get('interval'),status:form.get('status'),isPublic:form.get('is_public')==='on'
      });
      const limits={};
      for(const definition of definitions){
        const raw=String(form.get(`limit_${definition.key}`)||'').trim();
        limits[definition.key]={value:raw===''?null:Number(raw),enforcement:form.get(`enforcement_${definition.key}`)||'hard'};
      }
      await commerce('save_plan_limits',{planId:plan.id,limits});
      setEditing(null);setNotice('تم حفظ الباقة وحدودها. الحدود الصارمة ستطبق تلقائيًا على الإنشاءات الجديدة فقط دون حذف أي بيانات حالية.');router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر حفظ الباقة')}finally{setBusy(false)}
  }

  return <section className={styles.page}>
    <header className={styles.hero}><div><small>PLANS & ENTITLEMENTS</small><h1>الباقات وحدود الاستخدام</h1><p>حدد ما تتضمنه كل باقة فعليًا، من عدد الموظفين والطلاب إلى الدورات والعملاء والتخزين، مع تطبيق آمن لا يمس البيانات الموجودة.</p></div><div className={styles.heroActions}><button className={styles.primary} onClick={()=>setEditing({status:'active',interval:'year',currency:'SAR',isPublic:true,limits:[]})}>+ باقة جديدة</button></div></header>
    <section className={styles.kpis}>
      <article><span>الباقات المتاحة</span><b>{summary.planCount??activePlans.length}</b><small>مسودة ونشطة</small></article>
      <article><span>اشتراكات نشطة</span><b>{summary.activeSubscriptions||0}</b><small>بخلاف التجارب</small></article>
      <article><span>اشتراكات تجريبية</span><b>{summary.trialSubscriptions||0}</b><small>تحتاج تحويلًا أو تجديدًا</small></article>
      <article><span>الإيراد الشهري المتكرر</span><b>{money(summary.monthlyRecurringMinor||0)}</b><small>محسوب من الاشتراكات النشطة</small></article>
    </section>
    {notice&&<div className={styles.notice} role="status">{notice}</div>}{error&&<div className={styles.error} role="alert">{error}</div>}
    <div className={styles.toolbar}><div className={styles.toolbarTitle}><b>هيكل الباقات</b><small>{activePlans.length} باقة قابلة للإدارة</small></div></div>
    <section className={styles.plans}>{activePlans.map(plan=><article className={`${styles.plan} ${plan.amountMinor===0?styles.featured:''}`} key={plan.id}>
      <header><div><small>{plan.key}</small><h2>{plan.nameAr}</h2></div><span className={`${styles.status} ${styles[plan.status]||''}`}>{plan.status==='active'?'نشطة':plan.status==='draft'?'مسودة':'مؤرشفة'}</span></header>
      <p>{plan.description||'باقة أودير قابلة للتخصيص حسب احتياج المنشأة.'}</p>
      <div className={styles.price}><b>{plan.amountMinor?money(plan.amountMinor,plan.currency):'مجانية'}</b><small>{plan.amountMinor?intervalLabel[plan.interval]:''}</small></div>
      <div className={styles.limitList}>{(plan.limits||EMPTY).slice(0,6).map(limit=><div key={limit.key}><span>{limit.name}</span><b>{limit.value==null?'غير محدود':`${limit.value} ${limit.unit}`}</b></div>)}</div>
      <footer><small>{plan.subscriberCount||0} منشأة مشتركة</small><button className={styles.ghost} onClick={()=>setEditing(plan)}>تعديل الباقة</button></footer>
    </article>)}{!activePlans.length&&<div className={styles.empty}>لا توجد باقات بعد.</div>}</section>
    {editing&&<div className={styles.modalLayer}><button className={styles.backdrop} aria-label="إغلاق" onClick={()=>!busy&&setEditing(null)}/><form className={`${styles.modal} ${styles.wideModal}`} onSubmit={save}>
      <header><div><h2>{editing.id?'تعديل الباقة':'إنشاء باقة جديدة'}</h2><p>السعر وحدود الاستخدام والمستوى التشغيلي في مكان واحد.</p></div><button type="button" className={styles.close} onClick={()=>setEditing(null)}>×</button></header>
      <div className={styles.form}>
        <label className={styles.field}>مفتاح الباقة<input name="plan_key" pattern="[a-z][a-z0-9_]{2,60}" defaultValue={editing.key||''} disabled={Boolean(editing.id)} required/></label>
        <label className={styles.field}>الاسم العربي<input name="name_ar" defaultValue={editing.nameAr||''} required/></label>
        <label className={styles.field}>الاسم الإنجليزي<input name="name_en" defaultValue={editing.nameEn||''}/></label>
        <label className={styles.field}>دورة الفوترة<select name="interval" defaultValue={editing.interval||'year'}><option value="month">شهري</option><option value="year">سنوي</option><option value="one_time">مرة واحدة</option></select></label>
        <label className={styles.field}>السعر بالريال<input name="amount" type="number" min="0" step=".01" defaultValue={(Number(editing.amountMinor)||0)/100}/></label>
        <label className={styles.field}>الحالة<select name="status" defaultValue={editing.status||'active'}><option value="active">نشطة</option><option value="draft">مسودة</option><option value="archived">مؤرشفة</option></select></label>
        <input type="hidden" name="currency" value={editing.currency||'SAR'}/>
        <label className={`${styles.field} ${styles.wide}`}>وصف الباقة<textarea name="description" defaultValue={editing.description||''}/></label>
        <label className={`${styles.check} ${styles.wide}`}><input name="is_public" type="checkbox" defaultChecked={editing.isPublic!==false}/><span>عرض الباقة للعملاء الجدد</span></label>
        <section className={styles.limitsEditor}><header><div><b>حدود الباقة</b><p>اترك القيمة فارغة لتكون غير محدودة. «صارم» يمنع إنشاء سجلات جديدة بعد بلوغ الحد، و«تنبيه» يسمح مع إظهار التجاوز.</p></div></header>
          {definitions.map(definition=>{const saved=(editing.limits||EMPTY).find(limit=>limit.key===definition.key)||{};return <div className={styles.limitRow} key={definition.key}><span><b>{definition.name}</b><small>{definition.description}</small></span><input aria-label={`حد ${definition.name}`} name={`limit_${definition.key}`} type="number" min="0" placeholder="غير محدود" defaultValue={saved.value??''}/><select name={`enforcement_${definition.key}`} defaultValue={saved.enforcement||'hard'} disabled={!definition.enforceable}><option value="hard">حد صارم</option><option value="soft">تنبيه فقط</option></select></div>})}
        </section>
        <aside className={styles.hint}>تغيير الحد لا يحذف الموظفين أو الطلاب الموجودين. إذا كانت المنشأة أعلى من الحد الجديد، سيستمر عرض بياناتها ويُمنع فقط إنشاء سجلات إضافية عند اختيار «حد صارم».</aside>
        <footer className={styles.formFooter}><button type="button" className={styles.ghost} onClick={()=>setEditing(null)}>إلغاء</button><button className={styles.secondary} disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ الباقة والحدود'}</button></footer>
      </div>
    </form></div>}
  </section>;
}
