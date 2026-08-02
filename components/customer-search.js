'use client';

import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import styles from './customer-search.module.css';

const EMPTY_DATA={
  viewer:{},
  courses:[],
  staff:[],
  sources:[],
  results:[],
  total:0,
  hasCriteria:false
};

const STATUS_LABELS={
  new:'جديد',
  no_answer:'لا يرد',
  busy:'مشغول',
  follow_up:'متابعة',
  interested:'مهتم',
  very_interested:'مهتم جدًا',
  awaiting_payment:'بانتظار الدفع',
  payment_submitted:'أُرسل للتحقق',
  paid:'تم الدفع',
  postponed:'مؤجل',
  not_interested:'غير مهتم',
  unqualified:'غير مؤهل',
  wrong_number:'رقم خاطئ',
  duplicate:'مكرر',
  cancelled:'ملغي'
};

const QUALITY_LABELS={
  excellent:'ممتاز',
  qualified:'مؤهل',
  unqualified:'غير مؤهل',
  unrated:'غير مقيم'
};

const SOURCE_LABELS={
  manual:'إدخال يدوي',
  meta:'Meta',
  google:'Google',
  tiktok:'TikTok',
  snapchat:'Snapchat',
  website:'الموقع',
  whatsapp:'واتساب',
  referral:'ترشيح',
  woocommerce:'WooCommerce'
};

const digitValue=value=>String(value||'').replace(/\D/g,'');
const dateTime=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric',
  hour:'2-digit',
  minute:'2-digit'
}):'لا يوجد';

export default function CustomerSearch({slug,initialData}){
  const baseline=initialData||EMPTY_DATA;
  const formRef=useRef(null);
  const requestRef=useRef(0);
  const [data,setData]=useState(baseline);
  const [phone,setPhone]=useState('');
  const [searched,setSearched]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function runSearch(formData,{automatic=false}={}){
    const filters=Object.fromEntries(formData.entries());
    const phoneDigits=digitValue(filters.phone);
    const hasOtherCriteria=[
      'name','email','courseId','status','ownerStaffId','source'
    ].some(key=>String(filters[key]||'').trim());

    if(filters.phone&&phoneDigits.length<3){
      if(!automatic)setError('أدخل 3 أرقام على الأقل من رقم الجوال.');
      return;
    }
    if(!phoneDigits&&!hasOtherCriteria){
      if(!automatic)setError('أدخل رقم الجوال أو استخدم أحد خيارات البحث الأخرى.');
      return;
    }

    const requestId=++requestRef.current;
    setBusy(true);
    setError('');
    try{
      const params=new URLSearchParams({tenantSlug:slug});
      for(const [key,value] of Object.entries(filters)){
        if(String(value||'').trim())params.set(key,String(value).trim());
      }
      const response=await fetch(
        `/api/tenant/customer-search?${params.toString()}`,
        {cache:'no-store'}
      );
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر البحث عن العملاء');
      if(requestId!==requestRef.current)return;
      setData(payload.data||EMPTY_DATA);
      setSearched(true);
    }catch(err){
      if(requestId!==requestRef.current)return;
      setError(err instanceof Error?err.message:'تعذر البحث عن العملاء');
    }finally{
      if(requestId===requestRef.current)setBusy(false);
    }
  }

  function submit(event){
    event.preventDefault();
    runSearch(new FormData(event.currentTarget));
  }

  function reset(){
    requestRef.current+=1;
    formRef.current?.reset();
    setPhone('');
    setData({...baseline,results:[],total:0,hasCriteria:false});
    setSearched(false);
    setBusy(false);
    setError('');
  }

  useEffect(()=>{
    const phoneDigits=digitValue(phone);
    if(phoneDigits.length<3||!formRef.current)return undefined;
    const timer=setTimeout(()=>{
      if(formRef.current){
        runSearch(new FormData(formRef.current),{automatic:true});
      }
    },550);
    return ()=>clearTimeout(timer);
  // runSearch intentionally reads the latest form values after the debounce.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[phone]);

  const results=data.results||[];
  const courses=data.courses||baseline.courses||[];
  const staff=data.staff||baseline.staff||[];
  const sources=data.sources||baseline.sources||[];

  return <>
    <header className="mt-page-head">
      <div>
        <small>دليل العملاء</small>
        <h2>البحث عن عميل</h2>
        <p>ابحث أولًا برقم الجوال لمنع تكرار العميل، أو استخدم أي بيانات أخرى متاحة.</p>
      </div>
      <div className="mt-page-actions">
        <Link className="mt-button" href={`/tenant/${encodeURIComponent(slug)}/sales`}>إدارة المبيعات</Link>
      </div>
    </header>

    <section className={styles.searchPanel}>
      <div className={styles.phoneIntro}>
        <span className={styles.searchIcon} aria-hidden="true">⌕</span>
        <div>
          <b>ابدأ برقم الجوال</b>
          <p>يمكنك كتابة الرقم بأي صيغة. إدخال آخر 9 أرقام يكشف السجل المكرر حتى لو كان مسندًا إلى موظف آخر.</p>
        </div>
      </div>

      <form ref={formRef} onSubmit={submit} className={styles.form}>
        <label className={`${styles.field} ${styles.phoneField}`}>
          <span>رقم الجوال <em>البحث الأساسي</em></span>
          <input
            name="phone"
            value={phone}
            onChange={event=>setPhone(event.target.value)}
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            placeholder="05xxxxxxxx أو +9665xxxxxxxx"
            autoFocus
          />
          <small>يبدأ البحث تلقائيًا بعد كتابة 3 أرقام.</small>
        </label>

        <div className={styles.optionalHeading}>
          <div><b>خيارات بحث إضافية</b><small>كل الحقول التالية اختيارية</small></div>
          <span>اختياري</span>
        </div>

        <div className={styles.filters}>
          <label className={styles.field}><span>اسم العميل</span><input name="name" placeholder="الاسم أو جزء منه"/></label>
          <label className={styles.field}><span>البريد الإلكتروني</span><input name="email" type="search" inputMode="email" dir="ltr" placeholder="name@example.com"/></label>
          <label className={styles.field}><span>الدورة</span><select name="courseId" defaultValue=""><option value="">كل الدورات</option>{courses.map(course=><option key={course.id} value={course.id}>{course.nameAr}</option>)}</select></label>
          <label className={styles.field}><span>حالة العميل</span><select name="status" defaultValue=""><option value="">كل الحالات</option>{Object.entries(STATUS_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label className={styles.field}><span>الموظف المسؤول</span><select name="ownerStaffId" defaultValue=""><option value="">كل المسؤولين المتاحين</option>{staff.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <label className={styles.field}><span>مصدر العميل</span><select name="source" defaultValue=""><option value="">كل المصادر</option>{sources.map(source=><option key={source} value={source}>{SOURCE_LABELS[source]||source}</option>)}</select></label>
        </div>

        <div className={styles.actions}>
          <button className="mt-button primary" disabled={busy}>{busy?'جارٍ البحث…':'بحث عن العميل'}</button>
          <button className="mt-button" type="button" onClick={reset} disabled={busy}>مسح البحث</button>
        </div>
      </form>
    </section>

    {error&&<div className="mt-alert error" role="alert">{error}</div>}

    <section className={styles.results} aria-live="polite" aria-busy={busy}>
      <header>
        <div><small>نتائج البحث</small><h3>{searched?`${Number(data.total)||0} عميل مطابق`:'النتائج ستظهر هنا'}</h3></div>
        {searched&&Number(data.total)>results.length&&<span>يظهر أول {results.length} نتيجة</span>}
      </header>

      {!searched&&!busy&&<div className={styles.emptyState}>
        <span>⌕</span>
        <b>ابحث دون فتح قوائم طويلة</b>
        <p>استخدم رقم الجوال، أو اتركه فارغًا وابحث بالاسم أو الدورة أو الحالة أو المسؤول.</p>
      </div>}

      {searched&&!busy&&!results.length&&<div className={styles.emptyState}>
        <span>✓</span>
        <b>لا يوجد عميل مطابق</b>
        <p>راجع الرقم أو الفلاتر. يمكنك بعد ذلك فتح إدارة المبيعات وإضافة العميل إذا كانت لديك صلاحية الإضافة.</p>
        {data.viewer?.canWriteCrm&&<Link className="mt-button primary" href={`/tenant/${encodeURIComponent(slug)}/sales`}>إضافة عميل من شاشة المبيعات</Link>}
      </div>}

      <div className={styles.cards}>
        {results.map(result=><CustomerCard key={result.matchKey||result.id} slug={slug} result={result}/>) }
      </div>
    </section>
  </>;
}

function CustomerCard({slug,result}){
  const phoneDigits=digitValue(result.phone);
  const whatsappDigits=digitValue(result.whatsapp||result.phone);
  return <article className={`${styles.card} ${result.restricted?styles.restricted:''}`}>
    <header>
      <div>
        <span className={styles.avatar}>{Array.from(result.name||'ع')[0]}</span>
        <div><h3>{result.name||'عميل بدون اسم'}</h3><p dir="ltr">{result.phone||'لا يوجد رقم جوال'}</p></div>
      </div>
      <span className={styles.status}>{STATUS_LABELS[result.leadStatus]||result.leadStatus||'غير محدد'}</span>
    </header>

    {result.restricted&&<div className={styles.assignmentNotice}>
      <b>العميل موجود بالفعل</b>
      <p>هذا السجل مسند إلى {result.ownerName||'موظف آخر'}. لا تنشئ سجلًا جديدًا؛ اطلب من المسؤول استكمال المتابعة.</p>
    </div>}

    <dl>
      <div><dt>الدورة</dt><dd>{result.interestCourseName||'غير محددة'}</dd></div>
      <div><dt>المسؤول</dt><dd>{result.ownerName||'غير مسند'}</dd></div>
      <div><dt>جودة العميل</dt><dd>{QUALITY_LABELS[result.leadQuality]||result.leadQuality||'غير مقيم'}</dd></div>
      <div><dt>المصدر</dt><dd>{SOURCE_LABELS[result.source]||result.source||'غير محدد'}</dd></div>
      {result.organizationName&&<div><dt>الجهة</dt><dd>{result.organizationName}</dd></div>}
      {result.email&&<div><dt>البريد</dt><dd dir="ltr">{result.email}</dd></div>}
      {result.nextActionAt&&<div className={styles.wide}><dt>الإجراء القادم</dt><dd>{dateTime(result.nextActionAt)}</dd></div>}
    </dl>

    <footer>
      {result.canOpen&&result.id&&<Link className="mt-button primary" href={`/tenant/${encodeURIComponent(slug)}/sales?contact=${encodeURIComponent(result.id)}`}>فتح العميل في المبيعات</Link>}
      {result.canOpen&&phoneDigits&&<a className="mt-button" href={`tel:${phoneDigits}`}>اتصال</a>}
      {result.canOpen&&whatsappDigits&&<a className="mt-button" href={`https://wa.me/${whatsappDigits}`} target="_blank" rel="noreferrer">واتساب</a>}
    </footer>
  </article>;
}
