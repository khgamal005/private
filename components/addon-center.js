'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {addonHref} from '../lib/addons/placement-registry';
import styles from './addon-center.module.css';

const EMPTY=[];
const STATUS={
  included:'مشمولة في الباقة',
  active:'نشطة',
  trialing:'فترة تجريبية',
  pending:'بانتظار الموافقة',
  pending_payment:'بانتظار الدفع',
  pending_activation:'بانتظار التفعيل',
  past_due:'الدفع متأخر',
  scheduled:'مجدولة',
  paused:'موقوفة مؤقتًا',
  cancelled:'ملغاة',
  expired:'منتهية',
  disabled:'غير مفعلة'
};
const SOURCE={
  plan:'ضمن الباقة',
  subscription:'اشتراك مستقل',
  override:'تخصيص إداري',
  default:'افتراضي',
  billing:'شراء موثّق',
  platform:'تفعيل من المنصة',
  migration:'ترحيل آمن',
  none:'غير مفعّل'
};
const SURFACE={
  menu:'قائمة رئيسية',
  navigation:'قائمة رئيسية',
  page:'شاشة مستقلة',
  screen:'شاشة مستقلة',
  settings:'إعدادات',
  dashboard:'لوحة قيادة',
  dashboard_card:'بطاقة لوحة قيادة',
  report:'تقرير وتحليل',
  widget:'أداة داخلية',
  automation:'أتمتة',
  internal:'أداة داخلية',
  api:'واجهة API',
  job:'مهمة خلفية'
};
const INTERVAL={
  year:'سنويًا',
  month:'شهريًا',
  one_time:'مرة واحدة'
};

function money(amountMinor,currency='SAR'){
  if(amountMinor==null)return 'غير مسعّرة';
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency,maximumFractionDigits:0
  }).format((Number(amountMinor)||0)/100);
}

function formatDate(value,timezone='Asia/Riyadh'){
  if(!value)return '—';
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',timeZone:timezone
  }).format(parsed);
}

function productPrice(product){
  return product.price||product.pricing||product;
}

function productManifest(product){
  return product.manifest||{};
}

function requestKey(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  return `addon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function statusTone(status){
  if(['active','included'].includes(status))return styles.active;
  if(status==='trialing')return styles.trial;
  if(['pending','pending_payment','pending_activation'].includes(status))return styles.pending;
  if(['expired','paused','cancelled','past_due'].includes(status))return styles.inactive;
  return '';
}

export default function AddonCenter({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const products=data.products||EMPTY;
  const summary=data.summary||{};
  const timezone=data.tenant?.timezone||data.timezone||'Asia/Riyadh';
  const paymentMethods=data.paymentProviders||data.paymentMethods||EMPTY;
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState('all');
  const [selected,setSelected]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const openerRef=useRef(null);
  const activeAnnualValue=summary.activeAnnualValueMinor??products.reduce(
    (total,product)=>product.entitlement?.enabled
      ?total+(Number(productPrice(product).amountMinor)||0)
      :total,
    0
  );

  function openDetails(product,event){
    openerRef.current=event?.currentTarget||null;
    setSelected(product);
  }

  const closeDetails=useCallback(()=>setSelected(null),[]);
  useEffect(()=>{
    if(!selected)openerRef.current?.focus();
  },[selected]);

  const visible=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return products.filter(product=>{
      const entitlement=product.entitlement||{};
      const status=entitlement.effectiveStatus||entitlement.status||'disabled';
      const enabled=Boolean(entitlement.enabled);
      const filterMatch=filter==='all'
        ||(filter==='enabled'&&enabled)
        ||(filter==='available'&&!enabled&&!['pending','expired'].includes(status))
        ||(filter==='attention'&&['pending','expired','paused'].includes(status));
      const queryMatch=!needle||[
        product.name,product.description,product.featureKey,
        ...(product.surfaces||EMPTY).map(surface=>surface.title||surface.label)
      ].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle));
      return filterMatch&&queryMatch;
    });
  },[products,filter,query]);

  async function action(name,product){
    setBusy(`${name}-${product.key}`);
    setNotice('');
    setError('');
    try{
      const response=await fetch('/api/tenant/addon-center',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:name,
          p_payload:{
            productKey:product.key,
            subscriptionId:product.subscription?.id
              ||product.entitlement?.subscriptionId,
            revision:product.subscription?.revision
              ||product.entitlement?.revision,
            idempotencyKey:requestKey()
          }
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ الطلب');
      setNotice(name==='request_trial'
        ?'تم إرسال طلب التجربة. لن تُفعّل أي تكلفة قبل الموافقة.'
        :'تم إلغاء الطلب المعلّق.');
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر تنفيذ الطلب');
    }finally{
      setBusy('');
    }
  }

  return <section className={styles.center} aria-busy={Boolean(busy)}>
    <header className={styles.hero}>
      <div>
        <span>MODAAR ADD-ON MANAGER</span>
        <h2>إضافات منشأتك وتراخيصها</h2>
        <p>كل إضافة لها سعر سنوي، مدة ترخيص، أماكن ظهور محددة، وسجل مستقل. إيقاف الإضافة يمنع الوصول فقط ولا يحذف بياناتها.</p>
      </div>
      <Link href={`/tenant/${encodeURIComponent(slug)}/addons-store`}>فتح متجر الإضافات</Link>
    </header>

    <section className={styles.kpis}>
      <article><small>الإضافات المتاحة</small><b>{summary.products||products.length}</b><span>كتالوج مركزي موحّد</span></article>
      <article><small>التراخيص النشطة</small><b>{summary.enabled||0}</b><span>لهذه المنشأة فقط</span></article>
      <article><small>تنتهي خلال 30 يومًا</small><b>{summary.expiringWithin30Days??summary.expiringSoon??0}</b><span>تحتاج قرار تجديد</span></article>
      <article><small>قيمة أسعار الكتالوج</small><b>{money(activeAnnualValue,summary.currency||'SAR')}</b><span>للإضافات المفعلة وليست إثبات دفع</span></article>
    </section>

    <section className={styles.guardrail}>
      <span aria-hidden="true">✓</span>
      <div><b>بياناتك لا ترتبط بعمر الترخيص</b><p>عند انتهاء أو إيقاف أي إضافة تُخفى شاشاتها وتتوقف عملياتها الجديدة، بينما تبقى البيانات والسجلات والتكاملات محفوظة لاستعادتها عند التجديد. المحاكاة والفشل لا يُفوتران.</p></div>
    </section>

    {paymentMethods.length>0&&<section className={styles.payments}>
      <div><small>وسائل الدفع المعتمدة من المنصة</small><b>الدفع والتجديد من نفس الحساب</b></div>
      <ul>{paymentMethods.map(method=>{
        const available=method.available??(
          method.configured&&['active','verified'].includes(method.status)
        );
        return <li key={method.key} className={available?styles.ready:''}>
        <span>{method.name}</span><small>{available?'متاح':method.statusLabel||'قيد الإعداد'}</small>
      </li>})}</ul>
    </section>}

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}

    <section className={styles.toolbar}>
      <label><span aria-hidden="true">⌕</span><input aria-label="البحث في الإضافات" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث باسم الإضافة أو الشاشة…"/></label>
      <div role="group" aria-label="تصفية الإضافات">{[
        ['all','الكل'],['enabled','المفعّلة'],['available','المتاحة'],['attention','تحتاج إجراء']
      ].map(([key,label])=><button type="button" key={key} aria-pressed={filter===key} className={filter===key?styles.selected:''} onClick={()=>setFilter(key)}>{label}</button>)}</div>
    </section>

    <section className={styles.grid}>
      {visible.map(product=><AddonCard
        key={product.id||product.key}
        slug={slug}
        product={product}
        timezone={timezone}
        busy={busy}
        onAction={action}
        onDetails={event=>openDetails(product,event)}
      />)}
      {!visible.length&&<div className={styles.empty}><span aria-hidden="true">⌕</span><b>لا توجد إضافات مطابقة</b><p>غيّر الفلتر أو عبارة البحث.</p></div>}
    </section>

    {selected&&<AddonDetails slug={slug} product={selected} onClose={closeDetails}/>} 
  </section>;
}

function AddonCard({slug,product,timezone,busy,onAction,onDetails}){
  const entitlement=product.entitlement||{};
  const manifest=productManifest(product);
  const price=productPrice(product);
  const status=entitlement.effectiveStatus||entitlement.status||'disabled';
  const enabled=Boolean(entitlement.enabled);
  const actions=product.actions||{};
  const canOpen=actions.canOpen??(
    enabled&&['active','included','trialing'].includes(status)
  );
  const canCancelRequest=actions.canCancelRequest??status==='pending';
  const canRequestTrial=actions.canRequestTrial??(
    !enabled&&product.trialDays>0&&['disabled','expired','cancelled'].includes(status)
  );
  const canRenew=(actions.canRenew??['expired','cancelled'].includes(status))
    &&!['pending_payment','past_due'].includes(status);
  const canCheckout=(actions.canCheckout??(
    !enabled&&['disabled','expired','cancelled'].includes(status)
  ))&&!['pending_payment','past_due'].includes(status);
  const openHref=canOpen?addonHref(slug,product):null;
  const surfaces=product.surfaces||EMPTY;
  const periodEnd=entitlement.endsAt||entitlement.expiresAt||entitlement.periodEnd||entitlement.trialEnd;

  return <article className={`${styles.card} ${enabled?styles.enabled:''}`}>
    <header>
      <div className={styles.identity}><i aria-hidden="true">{product.iconKey||'+'}</i><span><small>{product.categoryLabel||product.featureKey}</small><h3>{product.name}</h3></span></div>
      <b className={`${styles.status} ${statusTone(status)}`}>{STATUS[status]||status}</b>
    </header>
    <p>{product.description||manifest.shortDescription||'إضافة مستقلة ضمن منظومة مُدار.'}</p>
    <section className={styles.priceLine}>
      <div><small>السعر</small><strong>{money(price.amountMinor,price.currency)}</strong><span>{INTERVAL[price.interval]||'دورية غير محددة'}</span></div>
      <div><small>الإصدار</small><b>{product.version||manifest.version||'1.0.0'}</b><span>{formatDate(product.publishedAt||manifest.releasedAt,timezone)}</span></div>
    </section>
    <dl className={styles.license}>
      <div><dt>بداية الترخيص</dt><dd>{formatDate(entitlement.startsAt||entitlement.periodStart,timezone)}</dd></div>
      <div><dt>نهاية الترخيص</dt><dd>{formatDate(periodEnd,timezone)}</dd></div>
      <div><dt>مصدر التفعيل</dt><dd>{SOURCE[entitlement.source]||entitlement.source||'—'}</dd></div>
      <div><dt>المتبقي</dt><dd>{entitlement.daysRemaining==null?'—':`${Math.max(0,Number(entitlement.daysRemaining)||0)} يوم`}</dd></div>
    </dl>
    <section className={styles.surfaces}>
      <small>تظهر الإضافة في</small>
      <div>{surfaces.slice(0,3).map(surface=><span key={surface.key||`${surface.type}-${surface.title||surface.label}`}><b>{SURFACE[surface.type]||surface.type}</b>{surface.title||surface.label}</span>)}</div>
      {!surfaces.length&&<p>لم تُسجّل مواضع الظهور بعد.</p>}
    </section>
    <footer>
      <button type="button" className={styles.secondary} onClick={onDetails}>التفاصيل والشاشات</button>
      {openHref?<Link href={openHref}>{product.key==='yeastar'?'فتح إضافة Yeastar':'فتح الإضافة'}</Link>
        :canCancelRequest?<button type="button" className={styles.danger} disabled={Boolean(busy)} onClick={()=>onAction('cancel_request',product)}>إلغاء الطلب</button>
          :canRequestTrial?<button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={()=>onAction('request_trial',product)}>{busy===`request_trial-${product.key}`?'جارٍ الإرسال…':`طلب تجربة ${product.trialDays} يومًا`}</button>
            :canRenew?<Link className={styles.primary} href={`/tenant/${encodeURIComponent(slug)}/addons-store`}>تجديد الإضافة</Link>
              :canCheckout?<Link className={styles.primary} href={`/tenant/${encodeURIComponent(slug)}/addons-store`}>شراء الإضافة</Link>
                :<span className={styles.noAction}>{enabled?'تعمل في الخلفية':'لا يوجد إجراء متاح الآن'}</span>}
    </footer>
  </article>;
}

function AddonDetails({slug,product,onClose}){
  const modalRef=useRef(null);
  const closeRef=useRef(null);
  const entitlement=product.entitlement||{};
  const openHref=product.actions?.canOpen===false
    ?null
    :addonHref(slug,product);
  const manifest=productManifest(product);
  const media=(product.media||EMPTY).filter(item=>
    ['screenshot','thumbnail','icon'].includes(item.type)
    &&String(item.displayUrl||'').startsWith('/api/tenant/')
  );
  const surfaces=product.surfaces||EMPTY;
  useEffect(()=>{
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    closeRef.current?.focus();
    function keyboard(event){
      if(event.key==='Escape')onClose();
      if(event.key!=='Tab'||!modalRef.current)return;
      const focusable=[...modalRef.current.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )];
      if(!focusable.length)return;
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',keyboard);
    return ()=>{
      document.removeEventListener('keydown',keyboard);
      document.body.style.overflow=previousOverflow;
    };
  },[onClose]);
  return <div className={styles.modalLayer}>
    <button className={styles.backdrop} tabIndex="-1" aria-label="إغلاق" onClick={onClose}/>
    <section ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="addon-details-title" aria-describedby="addon-details-description">
      <header><div><small>{product.featureKey}</small><h2 id="addon-details-title">{product.name}</h2></div><button ref={closeRef} type="button" aria-label="إغلاق" onClick={onClose}>×</button></header>
      <p id="addon-details-description" className={styles.longDescription}>{product.longDescription||manifest.longDescription||product.description}</p>
      {media.length?<div className={styles.gallery}>{media.map(item=><figure key={item.id||item.key}><Image src={item.displayUrl} alt={item.alt||product.name} width={item.width||720} height={item.height||420} sizes="(max-width: 800px) 92vw, 680px" unoptimized/>{(item.caption||item.alt)&&<figcaption>{item.caption||item.alt}</figcaption>}</figure>)}</div>
        :<div className={styles.screenPreview}><span>SCREEN MAP</span><div>{surfaces.slice(0,4).map(surface=><article key={surface.key||surface.title||surface.label}><small>{SURFACE[surface.type]||surface.type}</small><b>{surface.title||surface.label}</b><code dir="ltr">{surface.key||'internal'}</code></article>)}</div></div>}
      <section className={styles.surfaceList}>
        <h3>خريطة الظهور والتحكم</h3>
        {surfaces.map(surface=><article key={surface.key||`${surface.type}-${surface.title||surface.label}`}><span>{SURFACE[surface.type]||surface.type}</span><div><b>{surface.title||surface.label}</b><small>{surface.description||'يظهر فقط عند وجود ترخيص فعّال وصلاحية مستخدم مناسبة.'}</small></div><code dir="ltr">{surface.key||'internal'}</code></article>)}
        {!surfaces.length&&<p>لم تُسجّل مواضع الظهور لهذه الإضافة بعد.</p>}
      </section>
      <aside className={styles.dataPolicy}><b>سياسة البيانات</b><p>{product.dataPolicy||manifest.dataPolicy||'لا تُحذف بيانات الإضافة عند الإيقاف أو انتهاء الترخيص. يُمنع الوصول والكتابة الجديدة فقط حتى التجديد.'}</p></aside>
      <footer><button type="button" onClick={onClose}>إغلاق</button>{entitlement.enabled&&openHref&&<Link href={openHref}>فتح الإضافة</Link>}</footer>
    </section>
  </div>;
}
