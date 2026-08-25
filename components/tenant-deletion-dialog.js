'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import styles from './tenant-deletion-dialog.module.css';

const COUNT_LABELS={
  members:'العضويات',staff:'الموظفون',contacts:'العملاء',tasks:'المهام',
  students:'المتدربون',enrollments:'التسجيلات',courses:'الدورات',domains:'الدومينات',
  registrationRequests:'طلبات التسجيل',financialDocuments:'المستندات المالية',
  accountingEvents:'أحداث المحاسبة',payments:'المدفوعات',zatcaSubmissions:'إرسالات زاتكا',
  marketplaceOrders:'طلبات المتجر',bankTransfers:'التحويلات البنكية',
  addonEvents:'أحداث الإضافات',protectedAddons:'الإضافات المحمية',
  integrations:'التكاملات الفعلية',defaultIntegrationRows:'إعدادات التكامل الافتراضية',
  storageObjects:'ملفات الموقع'
};

export default function TenantDeletionDialog({tenant,onClose,onDeleted}){
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [reason,setReason]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [acknowledged,setAcknowledged]=useState(false);
  const dialogRef=useRef(null);
  const requestRef=useRef(null);
  const idempotencyRef=useRef('');
  const busyRef=useRef(false);
  const closeRef=useRef(onClose);

  useEffect(()=>{busyRef.current=busy;},[busy]);
  useEffect(()=>{closeRef.current=onClose;},[onClose]);

  const loadPreview=useCallback(async()=>{
    requestRef.current?.abort();
    const controller=new AbortController();
    requestRef.current=controller;
    setLoading(true);setError('');setPreview(null);
    try{
      const response=await fetch(
        `/api/platform/tenant-deletion?tenantId=${encodeURIComponent(tenant.id)}`,
        {cache:'no-store',signal:controller.signal}
      );
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر تجهيز معاينة الحذف');
      setPreview(payload.data);
      idempotencyRef.current=window.crypto.randomUUID();
    }catch(value){
      if(value instanceof Error&&value.name==='AbortError')return;
      setError(value instanceof Error?value.message:'تعذر تجهيز معاينة الحذف');
    }finally{
      if(requestRef.current===controller)setLoading(false);
    }
  },[tenant.id]);

  useEffect(()=>{
    loadPreview();
    const previousOverflow=document.body.style.overflow;
    const previousFocus=document.activeElement;
    document.body.style.overflow='hidden';
    const frame=window.requestAnimationFrame(()=>dialogRef.current?.focus());
    function keydown(event){
      if(event.key==='Escape'&&!busyRef.current){
        event.preventDefault();closeRef.current();
      }
    }
    document.addEventListener('keydown',keydown);
    return()=>{
      requestRef.current?.abort();
      window.cancelAnimationFrame(frame);
      document.body.style.overflow=previousOverflow;
      document.removeEventListener('keydown',keydown);
      if(previousFocus instanceof HTMLElement)previousFocus.focus();
    };
  },[loadPreview]);

  const valid=Boolean(
    preview?.canDelete
    &&reason.trim().length>=8
    &&confirmation.trim()===preview.confirmationPhrase
    &&acknowledged
    &&!busy
  );

  async function submit(event){
    event.preventDefault();
    if(!valid)return;
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/platform/tenant-deletion',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          action:'delete',tenantId:tenant.id,
          previewDigest:preview.previewDigest,
          confirmation:confirmation.trim(),reason:reason.trim(),
          idempotencyKey:idempotencyRef.current
        })
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new DeletionError(
        payload.error||'تعذر حذف المنشأة',payload.code||'request_failed'
      );
      onDeleted(payload.data);
    }catch(value){
      const stale=value instanceof DeletionError
        &&value.code==='tenant_deletion_preview_stale';
      setError(value instanceof Error?value.message:'تعذر حذف المنشأة');
      if(stale){
        setConfirmation('');setAcknowledged(false);
        await loadPreview();
      }
    }finally{setBusy(false);}
  }

  return <div className={styles.layer} dir="rtl">
    <button className={styles.backdrop} type="button" tabIndex={-1} aria-label="إغلاق" disabled={busy} onClick={onClose}/>
    <section
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tenant-delete-title"
      aria-describedby="tenant-delete-description"
      tabIndex={-1}
    >
      <header className={styles.header}>
        <span aria-hidden="true">!</span>
        <div><small>منطقة خطرة</small><h2 id="tenant-delete-title">حذف المنشأة نهائيًا</h2><p id="tenant-delete-description">لن يبدأ الحذف قبل فحص قاعدة البيانات وعرض كل ما سيتأثر.</p></div>
        <button type="button" className={styles.close} disabled={busy} onClick={onClose} aria-label="إغلاق">×</button>
      </header>

      <div className={styles.body}>
        <div className={styles.identity}>
          <div><span>المنشأة</span><b>{preview?.tenant?.name||tenant.name}</b></div>
          <div><span>الرابط</span><b dir="ltr">{preview?.tenant?.slug||tenant.slug}</b></div>
          <div><span>المعرّف</span><b dir="ltr">{tenant.id}</b></div>
        </div>

        {loading&&<div className={styles.loading} role="status"><i/><b>جارٍ فحص الاعتمادات والبيانات…</b><p>هذه معاينة فقط ولم يتم حذف أي شيء.</p></div>}
        {!loading&&error&&<div className={styles.error} role="alert">{error}<button type="button" onClick={loadPreview}>إعادة الفحص</button></div>}

        {!loading&&preview&&<>
          <section className={styles.preview}>
            <header><h3>معاينة البيانات</h3><span>{sumCounts(preview.counts)} سجلًا ظاهرًا في الملخص</span></header>
            <div className={styles.counts}>{Object.entries(preview.counts||{}).map(([key,value])=><div key={key}><span>{COUNT_LABELS[key]||key}</span><b>{formatNumber(value)}</b></div>)}</div>
          </section>

          {!preview.canDelete&&<section className={styles.blocked} role="alert">
            <h3>الحذف متوقف لحماية البيانات</h3>
            <p>لم يتم لمس المنشأة. عالج الأسباب التالية ثم أعد الفحص:</p>
            <ul>{preview.blockers.map(blocker=><li key={blocker.code}>{blocker.message}</li>)}</ul>
          </section>}

          {preview.canDelete&&<form className={styles.form} onSubmit={submit}>
            <div className={styles.warning}><b>ما الذي سيحدث؟</b><p>ستُحذف بيانات هذه المساحة فقط، وتُحرر هوية التسجيل والرابط والدومين لإمكانية التسجيل من الصفر. سيبقى حساب دخول المالك دون عضوية هذه المنشأة.</p></div>
            <label>سبب الحذف<textarea value={reason} onChange={event=>setReason(event.target.value)} minLength={8} maxLength={500} placeholder="مثال: منشأة اختبار أُنشئت ببيانات غير صحيحة" required/></label>
            <label>اكتب العبارة التالية للتأكيد <code>{preview.confirmationPhrase}</code><input dir="ltr" value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off" spellCheck="false" required/></label>
            <label className={styles.ack}><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/><span>أفهم أن بيانات المنشأة ستُحذف نهائيًا ولن يمكن استعادتها من لوحة أودير.</span></label>
            <footer><button type="button" className={styles.cancel} disabled={busy} onClick={onClose}>إلغاء</button><button type="submit" className={styles.delete} disabled={!valid}>{busy?'جارٍ الحذف والتحقق…':'حذف المنشأة نهائيًا'}</button></footer>
          </form>}
        </>}
      </div>
    </section>
  </div>;
}

function formatNumber(value){
  const number=Number(value);
  return new Intl.NumberFormat('ar-SA').format(Number.isFinite(number)?number:0);
}

function sumCounts(counts){
  return Object.values(counts||{}).reduce((sum,value)=>{
    const number=Number(value);return sum+(Number.isFinite(number)?number:0);
  },0);
}

class DeletionError extends Error{
  constructor(message,code){super(message);this.code=code;}
}
