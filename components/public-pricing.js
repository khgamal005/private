'use client';
import Link from 'next/link';
import {useState} from 'react';
import {OdeirSiteHeader,OdeirSiteFooter} from './odeir-site-chrome';
import styles from './public-pricing.module.css';
const money=value=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:0}).format(value/100);

export default function PublicPricing({catalog}){
 const [cycle,setCycle]=useState('month');
 const amount=item=>cycle==='month'?item.monthlyAmountMinor:item.annualAmountMinor;
 return <div className="odeir-experience"><div className="odeir-managed-header-shell"><OdeirSiteHeader/></div>
  <main className={styles.page} data-commerce-release={catalog.releaseKey||'independent-v1'}>
   <header className={styles.hero}><span>أودير · أسعار واضحة</span><h1>اختر نسخة مركزك.<br/>وأضف ما تحتاجه بصورة مستقلة.</h1><p>ابدأ بالمجانية، ثم اختر سعة البرنامج المناسبة لفريقك. لكل إضافة اشتراكها الخاص، بالسعر والمزايا نفسيهما في جميع نسخ أودير.</p></header>
   <div className={styles.cycle} role="group" aria-label="عرض الأسعار حسب مدة الاشتراك"><button type="button" aria-pressed={cycle==='month'} onClick={()=>setCycle('month')}>شهري</button><button type="button" aria-pressed={cycle==='year'} onClick={()=>setCycle('year')}>سنوي · شهران دون مقابل</button></div>
   <p className={styles.note}>الأسعار بالريال السعودي قبل الضريبة. السنوي: سداد مقدم لـ12 شهرًا بسعر 10 أشهر.</p>
   <section aria-labelledby="core-editions-title"><div className={styles.heading}><h2 id="core-editions-title">نسخ أودير</h2><p>تختلف النسخ حاليًا في سعة الفريق، مع وظائف التشغيل الحالية نفسها. لا نفرض حصصًا للعملاء والدفعات أو قيود تقارير غير مطبقة. الإضافات مستقلة.</p></div><div className={styles.plans}>{catalog.plans.map(plan=>{
    const limits=plan.profile?.limits||{};
    return <article className={plan.key==='core_professional'?styles.recommended:styles.plan} key={plan.key}><div>{plan.key==='core_professional'&&<span className={styles.badge}>للفرق المتنامية</span>}<h3>{plan.name}</h3><p>{plan.profile?.description||plan.description}</p></div><div className={styles.price}><b>{amount(plan)===0?'مجانية':money(amount(plan))}</b>{amount(plan)>0&&<span>ريال / {cycle==='month'?'شهر':'سنة'}</span>}</div><dl><div><dt>مستخدمو الفريق</dt><dd>{limits.staff}</dd></div><div><dt>وظائف التشغيل الأساسية</dt><dd>متاحة</dd></div><div><dt>العملاء والدفعات</dt><dd>دون حصة تجارية</dd></div><div><dt>الإضافات</dt><dd>اشتراك مستقل</dd></div></dl><Link className={styles.cta} href={amount(plan)===0?'/free-trial/apply':'/login'}>{amount(plan)===0?'ابدأ مجانًا':'دخول المنشأة'}</Link></article>;
   })}</div></section>
   <section aria-labelledby="addons-title"><div className={styles.heading}><h2 id="addons-title">الإضافات المستقلة</h2><p>إضافة واحدة، وجميع مزاياها المتاحة بسعر ثابت. لا مستويات، ولا حزم، ولا رسوم تجاوز لترخيص الإضافة.</p></div><div className={styles.addons}>{catalog.addons.map(addon=><article key={addon.key}><h3>{addon.name}</h3><p>{addon.description}</p><div><b>{amount(addon)===0?'مجانية':`${money(amount(addon))} ريال`}</b><span>{amount(addon)>0?(cycle==='month'?'شهريًا':'سنويًا'):'للجميع'}</span></div></article>)}</div><p className={styles.note}>يحدد متجر المنشأة الإضافات الجاهزة للتفعيل ومتطلبات مزودها. لا يبدأ الشراء لإضافة غير متاحة للتشغيل.</p></section>
   <section className={styles.clarity} aria-labelledby="pricing-clarity-title"><h2 id="pricing-clarity-title">ما الذي تدفع مقابله؟</h2><p>ترخيص الإضافة مستقل عن نسخة أودير. رسوم الرسائل والمكالمات وتراخيص الأطراف الأخرى منفصلة، وكذلك الخدمات البشرية التي تختارها. القوالب مجانية للجميع، وإثبات التسليم والتفويض الأساسي جزء من الإضافة التي تحتاجهما، دون اشتراك إضافي.</p><p>استضافة الملفات تخضع لضوابط المنصة التقنية، وليست وعدًا بتخزين غير محدود.</p><p>تغيير نسخة البرنامج لا يغير اشتراك الإضافة أو مزاياها. الضوابط الأمنية وقيود المزود التقنية لا تتحول إلى مستويات سعرية خفية. العقود السابقة ومددها المدفوعة محفوظة.</p><Link className={styles.cta} href="/free-trial/apply">سجّل منشأتك مجانًا</Link></section>
  </main><OdeirSiteFooter/>
 </div>;
}
