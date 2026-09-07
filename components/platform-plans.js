'use client';

import Link from 'next/link';
import {useCallback,useState} from 'react';
import CorePlanEditor from './core-plan-editor';
import baseStyles from './platform-commerce.module.css';
import editionStyles from './independent-core-editions.module.css';
// Compose shared and edition-scoped CSS classes instead of discarding the base.
const styles={...baseStyles,...Object.fromEntries(Object.entries(editionStyles).map(([key,value])=>[key,[baseStyles[key],value].filter(Boolean).join(' ')]))};

const money=(minor)=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:2}).format((Number(minor)||0)/100);

export default function PlatformPlans({initialData}){
  const [cycle,setCycle]=useState('month');
  const [editing,setEditing]=useState(null),[notice,setNotice]=useState('');
  const closeEditor=useCallback(()=>setEditing(null),[]);
  const plans=initialData?.plans||[];
  const legacy=initialData?.legacyPlans||[];
  return <section className={styles.page}>
    <header className={styles.hero}><div><small>ODEIR CORE EDITIONS</small><h1>نسخ أودير</h1><p>أربع نسخ مستقلة لتشغيل المنشأة. الإضافات تُشترى بصورة منفصلة بالسعر والمزايا نفسيهما لجميع النسخ، دون حزم أو عروض مشتركة.</p></div><div className={styles.heroActions}><Link className={styles.primary} href="/control/subscriptions">إدارة الاشتراكات</Link></div></header>
    <div className={styles.toolbar}><div className={styles.toolbarTitle}><b>الأسعار المعتمدة</b><small>بالريال السعودي، قبل الضريبة. السنوي مدفوع مقدمًا.</small></div><div className={styles.filters} role="group" aria-label="دورة فوترة نسخة أودير"><button type="button" aria-pressed={cycle==='month'} className={cycle==='month'?styles.active:''} onClick={()=>setCycle('month')}>شهري</button><button type="button" aria-pressed={cycle==='year'} className={cycle==='year'?styles.active:''} onClick={()=>setCycle('year')}>سنوي — 12 شهرًا</button></div></div>
    {notice&&<p className={styles.notice} role="status">{notice}</p>}
    <section className={styles.editionGrid}>{plans.map(plan=>{
      const profile=plan.commercialProfile||{};
      const limits=profile.limits||{};
      const amount=cycle==='year'?plan.annualAmountMinor:plan.monthlyAmountMinor;
      return <article className={`${styles.plan} ${plan.key==='core_professional'?styles.featured:''}`} key={plan.id}>
        <header><h2>{plan.nameAr}</h2><span className={`${styles.status} ${styles.active}`}>{plan.published===false?'مخفية عن الاشتراكات الجديدة':'نسخة مستقلة'}</span></header>
        <p>{profile.description||plan.description}</p>
        <div className={styles.price}><b>{amount===0?'مجانية':money(amount)}</b><small>{amount?cycle==='year'?'للسنة':'للشهر':'دون انتهاء'}</small></div>
        <div className={styles.limitList}>
          <div><span>مستخدمو الفريق، شامل المالك</span><b>{limits.staff??'—'}</b></div>
          <div><span>وظائف التشغيل الحالية</span><b>متاحة</b></div>
          <div><span>العملاء والدفعات</span><b>دون حصة تجارية</b></div>
          <div><span>الإضافات</span><b>مستقلة</b></div>
        </div>
        <footer><small>{plan.subscriberCount||0} منشأة على هذه النسخة</small>{plan.version&&<button type="button" className={styles.secondary} onClick={()=>{setNotice('');setEditing(plan);}}>تعديل الباقة</button>}<Link className={styles.ghost} href="/control/subscriptions">إسناد النسخة</Link></footer>
      </article>;
    })}</section>
    <aside className={styles.hint}>الفرق التجاري الحالي هو عدد المستخدمين فقط؛ وظائف التشغيل الحالية متاحة في النسخ الأربع، ولا حصص للعملاء أو الدفعات. لا تمنح النسخة ترخيص إضافة، ولا تغيّر تراخيص الإضافات عند الترقية أو التخفيض. تعديل التعريف ينطبق على الاشتراكات التي تُسند لاحقًا فقط. المقاعد والأسعار المحفوظة للعقود القائمة لا تتغير تلقائيًا.</aside>
    {legacy.length>0&&<section className={styles.panel}><header className={styles.panelHeader}><div><h2>النسخة الكاملة — للإدارة فقط</h2><p>باقة خفية لا تظهر في الأسعار العامة. عقد ريف وحقوقه ثابتة دون تعديل؛ يمكن للإدارة اختيار الكاملة لمنشأة أخرى بصورة صريحة.</p></div></header><div className={styles.legacyContracts}>{legacy.map(plan=><article key={plan.id}><b>{plan.nameAr}</b><span>{plan.subscriberCount||0} اشتراك قائم</span><small>{plan.key==='full'?'النسخة الكاملة محفوظة، بما فيها حقوق ريف، دون تعديل.':'شروط العقد السابق محفوظة حتى انتقال اختياري معتمد.'}</small></article>)}</div></section>}
    {editing&&<CorePlanEditor plan={editing} onClose={closeEditor} onSaved={()=>setNotice('تم حفظ تعريف الباقة؛ شروط الاشتراكات القائمة لم تتغير.')}/>}
  </section>;
}
