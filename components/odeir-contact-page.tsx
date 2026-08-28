'use client';

import {FormEvent,useRef,useState} from 'react';
import {OdeirSiteFooter,OdeirSiteHeader} from './odeir-site-chrome';
import styles from './odeir-contact-page.module.css';

type Props={snapshot:any};
type Status={kind:'idle'|'sending'|'success'|'error';message:string};

export default function OdeirContactPage({snapshot}:Props){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const startedAt=useRef(Date.now());
  const [status,setStatus]=useState<Status>({kind:'idle',message:''});

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(status.kind==='sending')return;
    const form=event.currentTarget;
    const data=new FormData(form);
    const payload={
      name:String(data.get('name')||''),organization:String(data.get('organization')||''),
      email:String(data.get('email')||''),phone:String(data.get('phone')||''),
      topic:String(data.get('topic')||''),message:String(data.get('message')||''),
      website:String(data.get('website')||''),startedAt:startedAt.current,
      sourcePage:'/contact',consent:true
    };
    setStatus({kind:'sending',message:'جارٍ إرسال رسالتك…'});
    try{
      const response=await fetch('/api/public/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json().catch(()=>({ok:false}));
      if(!response.ok||!result?.ok)throw new Error(String(result?.error||'send_failed'));
      form.reset();startedAt.current=Date.now();
      setStatus({kind:'success',message:'وصلت رسالتك بنجاح. سيتواصل معك فريق أودير عبر البيانات التي أرسلتها.'});
    }catch{
      setStatus({kind:'error',message:'تعذر إرسال الرسالة الآن. جرّب مرة أخرى بعد قليل أو راسلنا على admin@marktone.sa.'});
    }
  }

  return <div className="odeir-experience odeir-managed-page" dir="rtl" data-site-chrome="odeir-managed">
    <div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings}/></div>
    <main className={styles.page}>
      <section className={styles.hero}><div className={styles.heroInner}>
        <div><span className={styles.kicker}>تواصل مع أودير</span><h1>خلّنا نفهم احتياج منشأتك<br/>ونوجّهك للمسار الصحيح.</h1><p>سواء كان استفسارك عن المنصة، التفعيل، التكاملات، الفوترة أو حماية البيانات، أرسل التفاصيل وسنوجّه الرسالة مباشرة للفريق المختص.</p></div>
        <div className={styles.heroNote}><span>قناة التواصل الرسمية</span><strong>admin@marktone.sa</strong><small>لا ترسل كلمات مرور أو مفاتيح API أو بيانات حساسة داخل النموذج.</small></div>
      </div></section>

      <section className={styles.contactSection}>
        <div className={styles.infoColumn}><span className={styles.kickerDark}>كيف نساعدك؟</span><h2>رسالة واحدة… وتصل للمكان الصحيح.</h2><p>رتبنا النموذج ليجمع الحد الأدنى الذي يساعدنا على فهم الطلب دون أن نطلب منك معلومات لا نحتاجها.</p>
          <div className={styles.infoCards}>
            <article><b>01</b><div><strong>الدعم والتشغيل</strong><span>مشكلة في الحساب، صلاحيات، تسجيل دخول أو استخدام ميزة.</span></div></article>
            <article><b>02</b><div><strong>المبيعات والاشتراكات</strong><span>الخطط، الإضافات، التوسع أو طلب عرض مناسب للمنشأة.</span></div></article>
            <article><b>03</b><div><strong>الخصوصية والأمان</strong><span>طلبات البيانات، الأمان، الحذف أو المسائل المتعلقة بالسياسات.</span></div></article>
          </div>
        </div>

        <form className={styles.formCard} onSubmit={submit} noValidate>
          <div className={styles.formHeading}><span>أرسل رسالتك</span><h2>كيف نقدر نخدمك؟</h2></div>
          <div className={styles.grid}>
            <label><span>الاسم الكامل *</span><input name="name" autoComplete="name" required maxLength={120} placeholder="اكتب اسمك"/></label>
            <label><span>اسم المنشأة</span><input name="organization" autoComplete="organization" maxLength={160} placeholder="اسم المنشأة أو الجهة"/></label>
            <label><span>البريد الإلكتروني *</span><input name="email" type="email" autoComplete="email" required maxLength={180} placeholder="name@example.com" dir="ltr"/></label>
            <label><span>رقم الجوال</span><input name="phone" autoComplete="tel" maxLength={40} placeholder="05xxxxxxxx" dir="ltr"/></label>
            <label className={styles.full}><span>موضوع الرسالة *</span><select name="topic" required defaultValue=""><option value="" disabled>اختر نوع الطلب</option><option value="support">الدعم والتشغيل</option><option value="sales">المبيعات والاشتراكات</option><option value="billing">الفوترة والمدفوعات</option><option value="integration">التكاملات</option><option value="privacy">الخصوصية وحقوق البيانات</option><option value="security">أمن المعلومات</option><option value="other">موضوع آخر</option></select></label>
            <label className={styles.full}><span>تفاصيل الرسالة *</span><textarea name="message" required minLength={10} maxLength={4000} rows={7} placeholder="اكتب لنا التفاصيل التي تساعدنا على فهم طلبك…"/></label>
          </div>
          <input className={styles.honeypot} name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"/>
          <div className={styles.formFooter}><button type="submit" disabled={status.kind==='sending'}>{status.kind==='sending'?'جارٍ الإرسال…':'إرسال الرسالة'}<span>↗</span></button><p>بالإرسال أنت توافق على معالجة بيانات التواصل بالقدر اللازم للرد على طلبك وفق <a href="/p/privacy-policy">سياسة الخصوصية</a>.</p></div>
          {status.kind!=='idle'&&<div className={`${styles.status} ${styles[status.kind]}`} role="status">{status.message}</div>}
        </form>
      </section>
    </main>
    <OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>
  </div>;
}
