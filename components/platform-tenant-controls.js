'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import styles from './platform-tenant-controls.module.css';

const STATUS={active:'نشطة',trial:'تجريبية',suspended:'موقوفة',closed:'مغلقة',migrating:'قيد النقل'};
const formatDate=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeZone:'Asia/Riyadh'}).format(new Date(value)):'دون تاريخ انتهاء';
const money=value=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:2}).format(Number(value||0)/100);

export default function PlatformTenantControls({tenant,onClose,onChanged,onDelete}){
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [needsReload,setNeedsReload]=useState(false);
  const [planId,setPlanId]=useState('');
  const [cycle,setCycle]=useState('month');
  const [confirmation,setConfirmation]=useState(null);
  const dialog=useRef(null);
  const confirmationRef=useRef(null);
  const request=useRef(null);
  const inFlight=useRef(false);
  const mounted=useRef(true);
  const closeRef=useRef(onClose);
  useEffect(()=>{closeRef.current=onClose;},[onClose]);

  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setLoading(true);setError('');setNeedsReload(false);setConfirmation(null);
    try{
      const response=await fetch(`/api/platform/tenant-controls?tenantId=${encodeURIComponent(tenant.id)}`,{cache:'no-store',signal:controller.signal});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.success||result.data?.tenant?.id!==tenant.id)throw new Error(result.error||'تعذر تحميل تفاصيل المنشأة.');
      if(controller.signal.aborted)return;
      setData(result.data);setPlanId(result.data.subscription?.planId||result.data.plans?.[0]?.id||'');
      setCycle(result.data.subscription?.billingInterval==='year'?'year':'month');
    }catch(e){if(e.name!=='AbortError'&&mounted.current){setError(e.message||'تعذر تحميل التفاصيل.');setNeedsReload(true);}}
    finally{if(mounted.current&&request.current===controller)setLoading(false);}
  },[tenant.id]);

  useEffect(()=>{
    mounted.current=true;load();
    const previousOverflow=document.body.style.overflow;const previousFocus=document.activeElement;
    document.body.style.overflow='hidden';dialog.current?.focus();
    function keydown(event){
      if(event.key==='Escape'&&!inFlight.current){event.preventDefault();closeRef.current();return;}
      if(event.key!=='Tab')return;
      const nodes=[...(dialog.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')||[])].filter(node=>node.getClientRects().length);
      const first=nodes[0],last=nodes.at(-1);if(!first){event.preventDefault();dialog.current?.focus();return;}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',keydown);
    return()=>{mounted.current=false;request.current?.abort();document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',keydown);if(previousFocus instanceof HTMLElement)previousFocus.focus();};
  },[load]);

  useEffect(()=>{if(confirmation){confirmationRef.current?.focus();confirmationRef.current?.scrollIntoView({block:'nearest',behavior:'smooth'});}},[confirmation]);

  const current=data?.tenant||tenant;
  const plans=data?.plans||[];
  const selected=plans.find(p=>p.id===planId);
  const noTerm=selected?.key==='core_free'||selected?.key==='full';
  const blocked=loading||busy||needsReload;
  const overCapacity=selected?.staffLimit!=null&&current.members>selected.staffLimit;

  function review(action){
    if(blocked)return;
    setError('');setNotice('');
    if(action==='set_plan'){
      if(!data.actions.canSetPlan||!selected)return;
      setConfirmation({action,title:'تأكيد تغيير الباقة',description:`${data.subscription?.planName||'بدون باقة'} ← ${selected.name}`,
        detail:noTerm?'الاشتراك الجديد دون تاريخ انتهاء.':`تبدأ مدة ${cycle==='year'?'سنة':'شهر'} من وقت التأكيد. السعر المرجعي ${money(cycle==='year'?selected.annualAmountMinor:selected.monthlyAmountMinor)} قبل الضريبة؛ دون تحصيل مالي في هذا الإجراء.`,
        payload:{planId:selected.id,billingInterval:noTerm?'month':cycle,confirmation:`تغيير باقة ${current.slug}`}});
    }else{
      if(!data.actions.canSetStatus)return;
      const enable=current.status!=='active';
      setConfirmation({action:'set_status',title:enable?'تأكيد تفعيل المنشأة':'تأكيد إيقاف المنشأة',
        description:enable?'استعادة وصول المستخدمين إلى مساحة المنشأة.':'منع المستخدمين من الوصول إلى مساحة المنشأة.',
        detail:'تبقى البيانات والاشتراك والإضافات محفوظة. هذا الإجراء لا يغيّر مدة الاشتراك أو يعالج التسوية المالية.',
        payload:{status:enable?'active':'suspended',confirmation:`${enable?'تفعيل':'إيقاف'} ${current.slug}`}});
    }
  }

  async function confirm(){
    if(!confirmation||inFlight.current||blocked)return;
    inFlight.current=true;setBusy(true);setError('');
    try{
      const response=await fetch('/api/platform/tenant-controls',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({tenantId:tenant.id,action:confirmation.action,payload:{...confirmation.payload,expectedVersion:data.version}})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.success||result.data?.tenant?.id!==tenant.id)throw new Error(result.error||'تعذر تأكيد العملية. أعد تحميل التفاصيل قبل المحاولة مرة أخرى.');
      if(!mounted.current)return;
      setData(result.data);setPlanId(result.data.subscription?.planId||'');
      setCycle(result.data.subscription?.billingInterval==='year'?'year':'month');
      setNotice(confirmation.action==='set_plan'?'تم تغيير الباقة إداريًا، دون تحصيل مبلغ أو تغيير إضافات المنشأة.':result.data.tenant.status==='active'?'تم تفعيل المنشأة.':'تم إيقاف المنشأة مع الاحتفاظ ببياناتها.');
      setConfirmation(null);onChanged(result.data);
    }catch(e){if(mounted.current){setError(e.message||'تعذر تنفيذ الإجراء.');setNeedsReload(true);setConfirmation(null);}}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }

  return <div className={styles.layer} dir="rtl">
    <button type="button" className={styles.backdrop} aria-label="إغلاق إدارة المنشأة" tabIndex={-1} disabled={busy} onClick={onClose}/>
    <section className={styles.dialog} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="tenant-controls-title" tabIndex={-1}>
      <header className={styles.header}><div><small>إدارة المنشأة</small><h2 id="tenant-controls-title">{current.name}</h2><span dir="ltr">{current.slug}</span></div><button type="button" className={styles.close} aria-label="إغلاق" disabled={busy} onClick={onClose}>×</button></header>
      <div className={styles.body}>
        {loading&&<p role="status" className={styles.hint}>جارٍ تحميل الحالة والصلاحيات الحالية…</p>}
        {error&&<div role="alert" className={styles.error}>{error}<button type="button" disabled={busy||loading} onClick={load}>إعادة تحميل التفاصيل</button></div>}
        {notice&&<div role="status" className={styles.notice}>{notice}</div>}
        {data&&!loading&&<>
          <div className={styles.summary}><div><small>حالة المنشأة</small><b>{STATUS[current.status]||current.status}</b></div><div><small>الباقة الحالية</small><b>{data.subscription?.planName||'بدون باقة'}</b></div><div><small>مستخدمو الفريق</small><b>{current.members}</b></div><div><small>نهاية اشتراك الباقة</small><b>{data.subscription?formatDate(data.subscription.periodEnd):'لا يوجد اشتراك'}</b></div></div>
          {current.reefProtected&&<aside className={styles.hint}><b>ريف على النسخة الكاملة المحفوظة</b><p>تغيير الباقة والإيقاف والحذف غير متاحين هنا لحماية التشغيل الحالي. لم تتغير بيانات ريف أو صلاحياتها.</p></aside>}
          <section className={styles.card}><header><span className={styles.step}>1</span><div><h3>تغيير الباقة يدويًا</h3><p>اختيار مستقل عن حالة تشغيل المنشأة وإضافاتها.</p></div></header>
            {data.actions.canSetPlan?<>
              <div className={styles.fields}><label>الباقة الجديدة<select aria-label="الباقة الجديدة" value={planId} disabled={blocked} onChange={event=>{setPlanId(event.target.value);setConfirmation(null);}}>{plans.map(p=><option key={p.id} value={p.id}>{p.name}{p.internalOnly?' — للإدارة فقط':''}</option>)}</select></label>
                <label>مدة الاشتراك<select aria-label="مدة الاشتراك" value={noTerm?'none':cycle} disabled={blocked||noTerm} onChange={event=>{setCycle(event.target.value);setConfirmation(null);}}>{noTerm?<option value="none">دون انتهاء</option>:<><option value="month">شهري</option><option value="year">سنوي</option></>}</select></label></div>
              {selected&&<p className={styles.hint}>{selected.internalOnly?'النسخة الكاملة داخلية ولا تظهر في صفحة الأسعار.':`${selected.staffLimit} مستخدمين شامل المالك · السعر المرجعي ${money(cycle==='year'?selected.annualAmountMinor:selected.monthlyAmountMinor)} ${cycle==='year'?'سنويًا':'شهريًا'} قبل الضريبة.`}</p>}
              {overCapacity&&<p className={styles.warning}>عدد المستخدمين الحالي ({current.members}) أكبر من حد هذه الباقة ({selected.staffLimit}). لن يُحذف أو يُعطّل أي مستخدم؛ تُمنع الإضافات الجديدة للفريق حتى يتوافق العدد مع الحد.</p>}
              <p className={styles.muted}>يُحفظ الاشتراك السابق في السجل ويبدأ اشتراك الباقة المختارة. لا ينشئ الإجراء دفعة مالية، ولا يفعّل منشأة موقوفة.</p>
              <button type="button" className={styles.primary} disabled={blocked||!selected} onClick={()=>review('set_plan')}>مراجعة تغيير الباقة</button>
            </>:<p className={styles.muted}>{current.reefProtected?'الباقة محفوظة دون تغيير.':'تحتاج صلاحية إدارة الفوترة لتغيير الباقة.'}</p>}
          </section>
          <section className={styles.card}><header><span className={styles.step}>2</span><div><h3>تفعيل أو إيقاف المنشأة</h3><p>الإيقاف يمنع وصول مستخدميها، ولا يحذف بياناتها.</p></div></header>
            <button type="button" className={current.status==='active'?styles.warningButton:styles.primary} disabled={blocked||!data.actions.canSetStatus} onClick={()=>review('set_status')}>{current.status==='active'?'إيقاف المنشأة':'تفعيل المنشأة'}</button>
            {!data.actions.canSetStatus&&!current.reefProtected&&<p className={styles.muted}>تحتاج صلاحية إدارة المنشآت لتنفيذ هذا الإجراء.</p>}
          </section>
          {confirmation&&<section ref={confirmationRef} tabIndex={-1} className={styles.confirmation} role="alert" aria-labelledby="tenant-action-confirm-title"><h3 id="tenant-action-confirm-title">{confirmation.title}</h3><p><b>{current.name}</b> · <span dir="ltr">{current.slug}</span></p><p>{confirmation.description}</p><p>{confirmation.detail}</p><footer><button type="button" className={styles.primary} disabled={blocked} onClick={confirm}>{busy?'جارٍ التنفيذ…':'تأكيد التنفيذ'}</button><button type="button" className={styles.secondary} disabled={busy} onClick={()=>setConfirmation(null)}>رجوع</button></footer></section>}
          <section className={`${styles.card} ${styles.danger}`}><header><span className={styles.step}>3</span><div><h3>حذف المنشأة نهائيًا</h3><p>لصاحب صلاحية الحذف فقط، وبعد معاينة البيانات والتأكيد الكتابي.</p></div></header><p className={styles.muted}>تظهر أسباب المنع عند وجود سجلات مالية أو تكاملات أو بيانات محمية. الإيقاف هو البديل الآمن عند الحاجة للاحتفاظ بالسجلات.</p><button type="button" className={styles.deleteButton} disabled={blocked||!data.actions.canDelete} onClick={()=>onDelete(current)}>فتح معاينة الحذف</button></section>
        </>}
      </div>
      <footer className={styles.footer}><span>كل إجراء يخص هذه المنشأة فقط.</span><button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>إغلاق</button></footer>
    </section>
  </div>;
}
