'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {amountMinor} from '../lib/core-plan-editor.mjs';
import styles from './core-plan-editor.module.css';
const money=v=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(v/100);
export default function CorePlanEditor({plan,onClose,onSaved}){
 const router=useRouter(),dialog=useRef(null),lock=useRef(false);
 const [draft,setDraft]=useState({nameAr:plan.nameAr,description:plan.commercialProfile?.description||plan.description||'',
 monthly:String(plan.monthlyAmountMinor/100),annual:String(plan.annualAmountMinor/100),staff:String(plan.commercialProfile?.limits?.staff||1),
 displayOrder:String(plan.displayOrder??10),published:plan.published!==false,reason:''});
 const [review,setReview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const free=plan.key==='core_free';
 useEffect(()=>{
  const opener=document.activeElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';
  dialog.current?.querySelector('button')?.focus();
  const keyboard=e=>{if(e.key==='Escape'&&!lock.current)onClose();if(e.key!=='Tab')return;
   const items=[...dialog.current.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),summary')];
   const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}};
  document.addEventListener('keydown',keyboard);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keyboard);opener?.focus();};
 },[onClose]);
 useEffect(()=>{if(review)dialog.current?.querySelector('h3')?.focus();},[review]);
 const field=(key,value)=>setDraft(x=>({...x,[key]:value}));
 function prepare(e){e.preventDefault();setError('');const m=amountMinor(draft.monthly),y=amountMinor(draft.annual);
  if(m===null||y===null||(!free&&(m===0||y===0))){setError('أدخل أسعارًا صحيحة بحد أقصى منزلتين عشريتين.');return;}
  setReview({nameAr:draft.nameAr.trim(),description:draft.description.trim(),monthlyAmountMinor:m,annualAmountMinor:y,
   staffLimit:Number(draft.staff),displayOrder:Number(draft.displayOrder),published:draft.published,reason:draft.reason.trim(),expectedVersion:plan.version,confirmed:true});
 }
 async function save(){if(lock.current||!review)return;lock.current=true;setBusy(true);setError('');
  try{const response=await fetch('/api/platform/plan-editor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:plan.id,payload:review})});
   const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'تعذر الحفظ.');
   onSaved(result.data);router.refresh();onClose();
  }catch(e){setError(e.message||'تعذر الحفظ.');setReview(null);}finally{lock.current=false;setBusy(false);}
 }
 return <div className={styles.layer}><div className={styles.backdrop}/><section ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="plan-editor-title" dir="rtl" data-plan-editor="v1">
  <header><div><small>إدارة تعريف الباقة</small><h2 id="plan-editor-title">تعديل {plan.nameAr}</h2></div><button type="button" aria-label="إغلاق" disabled={busy} onClick={onClose}>×</button></header>
  {error&&<p className={styles.error} role="alert">{error}</p>}
  <aside className={styles.notice}>التعديل للاشتراكات التي تُسند بعد الحفظ. أسعار الاشتراكات القائمة ومقاعدها ومددها محفوظة، والإضافات مستقلة. لا تُحصّل أموال عند الحفظ.</aside>
  {!review?<form onSubmit={prepare} className={styles.form}>
   <label>اسم الباقة<input required minLength={2} maxLength={100} value={draft.nameAr} onChange={e=>field('nameAr',e.target.value)}/></label>
   <label>ترتيب العرض<input required type="number" min={0} max={10000} step={1} value={draft.displayOrder} onChange={e=>field('displayOrder',e.target.value)}/></label>
   <label>السعر الشهري بالريال<input required readOnly={free} dir="ltr" inputMode="decimal" value={draft.monthly} onChange={e=>field('monthly',e.target.value)}/></label>
   <label>السعر السنوي بالريال<input required readOnly={free} dir="ltr" inputMode="decimal" value={draft.annual} onChange={e=>field('annual',e.target.value)}/></label>
   {!free&&<button className={styles.suggestion} type="button" onClick={()=>{const m=amountMinor(draft.monthly);if(m!==null)field('annual',String(m*10/100));}}>اقتراح السنوي = الشهري × 10</button>}
   <label>عدد المستخدمين شامل المالك<input required type="number" min={1} max={10000} step={1} value={draft.staff} onChange={e=>field('staff',e.target.value)}/></label>
   <label className={styles.check}><input type="checkbox" disabled={free} checked={draft.published} onChange={e=>field('published',e.target.checked)}/>إظهار الباقة وإتاحة الاشتراك الجديد</label>
   <label className={styles.wide}>وصف الباقة<textarea required minLength={5} maxLength={600} rows={3} value={draft.description} onChange={e=>field('description',e.target.value)}/></label>
   <label className={styles.wide}>سبب التعديل<input required minLength={3} maxLength={500} value={draft.reason} onChange={e=>field('reason',e.target.value)}/></label>
   <p className={styles.help}>الأسعار قبل الضريبة. إخفاء الباقة لا يوقف المشتركين الحاليين. لا تتضمن هذه الشاشة تغيير النسخة الكاملة أو إضافة حدود غير مطبقة.</p>
   <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} type="submit">مراجعة التغييرات</button></footer>
  </form>:<div className={styles.review}>
   <h3 tabIndex={-1}>مراجعة قبل الحفظ</h3><table><thead><tr><th>البند</th><th>قبل</th><th>بعد</th></tr></thead><tbody>
    {[["الاسم",plan.nameAr,review.nameAr],["شهريًا",money(plan.monthlyAmountMinor),money(review.monthlyAmountMinor)],
    ["سنويًا",money(plan.annualAmountMinor),money(review.annualAmountMinor)],["المستخدمون",plan.commercialProfile.limits.staff,review.staffLimit],
    ["الظهور",plan.published!==false?'متاحة':'مخفية',review.published?'متاحة':'مخفية']].map(([k,a,b])=><tr key={k}><th>{k}</th><td>{a}</td><td>{b}</td></tr>)}
   </tbody></table><p>{review.reason}</p><footer><button disabled={busy} onClick={()=>setReview(null)}>رجوع للتعديل</button><button className={styles.primary} disabled={busy} onClick={save}>{busy?'جارٍ الحفظ…':'تأكيد حفظ الباقة'}</button></footer>
  </div>}
  {!review&&<details className={styles.history}><summary>سجل التعديلات ({plan.history?.length||0})</summary>{(plan.history||[]).map(h=><article key={h.id}><b>{h.reason}</b><small>{new Date(h.created_at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</small><p>شهري: {money(h.before_value.monthlyAmountMinor)} ← {money(h.after_value.monthlyAmountMinor)} · سنوي: {money(h.before_value.annualAmountMinor)} ← {money(h.after_value.annualAmountMinor)}</p><p>المستخدمون: {h.before_value.commercialProfile?.limits?.staff} ← {h.after_value.commercialProfile?.limits?.staff}</p></article>)}{!plan.history?.length&&<p>لا توجد تعديلات محفوظة بعد.</p>}</details>}
 </section></div>;
}
