'use client';

import {useState} from 'react';
import styles from './accounting-workspace.module.css';

const money=(n,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency}).format(Number(n||0)/100);
const effects={cancel_registration:'إلغاء التسجيل وإخلاء المقعد',price_adjustment:'تخفيض السعر مع استمرار التدريب',credit_transfer:'تحويل المبلغ إلى رصيد للعميل'};
const minor=value=>Math.round(Number(value||0)*100);
function Field({label,children}){return <label><span>{label}</span>{children}</label>}
function Modal({title,children,onClose}){return <div className={styles.backdrop}><section className={styles.modal} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="إغلاق">×</button></header>{children}</section></div>}

export function FinancialGovernancePanel({data,viewer,busy,onAct,onModal}){
 const [preview,setPreview]=useState(null);
 const credits=Array.isArray(data.customerCredits)?data.customerCredits:[];
 const reviews=Array.isArray(data.incentiveAdjustmentReviews)?data.incentiveAdjustmentReviews:[];
 return <div className={styles.stack}>
  {viewer.canManageSettings&&<section className={styles.panel}><header><div><h2>ترحيل التحصيل إلى الحسابات</h2><p>تُرحّل المدفوعات الجديدة المتحقق منها مرة واحدة مع حفظ مصدرها وتاريخها. استيراد الدفعات السابقة إجراء مستقل.</p></div><strong>{data.governance?.enabled?'مفعّل':'غير مفعّل'}</strong></header>
   {!preview?<button disabled={Boolean(busy)} onClick={async()=>{const result=await onAct('preview-governance',{},'تم تجهيز معاينة التفعيل');if(result)setPreview(result);}}>معاينة الأثر</button>:<div>
    <p>التغييرات على السجلات السابقة: {preview.historicalRowsModified}. دفعات سابقة تحتاج مراجعة مستقلة: {preview.legacyVerifiedUnimported}.</p>
    <p>تأكيد التحصيل متاح للمخول ماليًا. امنح الصلاحية من فريق العمل لمن سيعتمد الدفعات قبل بدء التشغيل.</p>
    <button className={styles.primary} disabled={Boolean(busy)} onClick={async()=>{const result=await onAct('set-governance',{enabled:!data.governance?.enabled,confirmation:'ENABLE_FINANCIAL_GOVERNANCE'},'تم حفظ تفعيل ترحيل التحصيل');if(result)setPreview(null);}}>{data.governance?.enabled?'إيقاف الترحيل التلقائي الجديد':'تأكيد التفعيل للدفعات الجديدة'}</button>
   </div>}
  </section>}
  {credits.length>0&&<section className={styles.panel}><header><h2>أرصدة العملاء</h2></header>{credits.map(credit=><div className={styles.rowActions} key={credit.id}><b>{money(credit.availableMinor,credit.currency)}</b><span>رصيد متاح لتسجيل آخر</span>{viewer.canApprovePayments&&Number(credit.availableMinor)>0&&<button onClick={()=>onModal({type:'credit',credit})}>استخدام الرصيد</button>}</div>)}</section>}
  {reviews.length>0&&<section className={styles.panel}><header><div><h2>مراجعة أثر الاسترداد على الحوافز</h2><p>يُحفظ الحافز السابق، وتحتاج التسوية قرارًا مستقلًا. اعتمادها لا يخصم من الرواتب تلقائيًا.</p></div></header>{reviews.map(review=><div className={styles.rowActions} key={review.id}><span>التخفيض المقترح: {money(Number(review.proposedReduction)*100)}</span><span>{review.status==='pending'?'بانتظار المراجعة':review.status==='approved'?'معتمد للمراجعة المالية':'مرفوض'}</span>{review.status==='pending'&&viewer.canApproveIncentives&&<button onClick={()=>onModal({type:'incentive-review',review})}>مراجعة التسوية</button>}</div>)}</section>}
 </div>;
}

export function RefundGovernanceForm({payment,refund=null,invoices,busy,onClose,onSave}){
 const allocations=Array.isArray(payment.invoiceAllocations)?payment.invoiceAllocations:[];
 const eligible=invoices.filter(item=>item.customerAccountId===payment.customerAccountId&&item.currency===payment.currency);
 const [form,setForm]=useState({amount:refund?Number(refund.amountMinor)/100:'',invoiceId:refund?.invoiceId||'',creditNoteId:refund?.creditNoteId||'',reason:refund?.reason||'',effect:refund?.effect||'price_adjustment',handoffId:refund?.handoffId||(payment.sourceType==='registration_handoff'?payment.sourceId:'')});
 const change=event=>{const {name,value}=event.target;setForm(current=>({...current,[name]:value,...(name==='invoiceId'?{creditNoteId:'',handoffId:payment.sourceType==='registration_handoff'?payment.sourceId:allocations.find(a=>a.invoiceId===value)?.handoffId||''}:{})}));};
 return <Modal title={refund?'تحديد أثر طلب الاسترداد':'طلب استرداد أو رصيد'} onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({...(refund?{refundId:refund.id}:{paymentId:payment.id,amountMinor:minor(form.amount)}),invoiceId:form.invoiceId||null,creditNoteId:form.creditNoteId||null,reason:form.reason,effect:form.effect,handoffId:form.handoffId||null});}}>
  <p className={styles.wide}>من الدفعة {payment.number} بقيمة {money(payment.amountMinor,payment.currency)}. يعتمد الطلب شخص آخر مخول.</p>
  {refund&&<p className={styles.wide}>حفظ التصنيف يعيد الطلب إلى انتظار اعتماد شخص آخر، ويُحفظ سبب التعديل في سجل المراجعة.</p>}
  <Field label="أثر العملية"><select name="effect" value={form.effect} onChange={change}>{Object.entries(effects).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field>
  <Field label={`المبلغ (${payment.currency})`}><input type="number" min="0.01" step="0.01" max={Number(payment.amountMinor)/100} name="amount" value={form.amount} onChange={change} disabled={Boolean(refund)} required/></Field>
  <Field label="الفاتورة"><select name="invoiceId" value={form.invoiceId} onChange={change} required={allocations.length>0}><option value="">مبلغ غير موزع على فاتورة</option>{eligible.filter(item=>item.type==='invoice'&&allocations.some(a=>a.invoiceId===item.id)).map(item=><option key={item.id} value={item.id}>{item.number}</option>)}</select></Field>
  <Field label="الإشعار الدائن المرتبط"><select name="creditNoteId" value={form.creditNoteId} onChange={change} required={Boolean(form.invoiceId)}><option value="">اختر إشعارًا صادرًا</option>{eligible.filter(item=>item.type==='credit_note'&&item.status==='issued'&&item.parentDocumentId===form.invoiceId).map(item=><option key={item.id} value={item.id}>{item.number}</option>)}</select></Field>
  {form.invoiceId&&<p className={styles.wide}>إذا لم يظهر الإشعار، أنشئ إشعارًا دائنًا مرتبطًا بهذه الفاتورة من قسم الفواتير وأصدره أولًا.</p>}
  {form.effect==='cancel_registration'&&!form.handoffId&&<p className={styles.wide}>اختر الفاتورة المرتبطة بتسجيل واحد. إذا كان الربط غير محدد، راجع ربط الفاتورة بالتسجيل قبل الإلغاء.</p>}
  <Field label="السبب"><textarea name="reason" minLength={3} value={form.reason} onChange={change} required/></Field>
  <footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)||(form.effect==='cancel_registration'&&!form.handoffId)}>إرسال للمراجعة</button></footer>
 </form></Modal>;
}

export function RefundExecutionForm({refund,busy,onClose,onSave}){
 const [reference,setReference]=useState('');const credit=refund.settlementKind==='credit';
 return <Modal title={credit?'تأكيد إنشاء الرصيد':'إثبات تنفيذ الاسترداد'} onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({refundId:refund.id,externalReference:reference||null});}}>
  <p className={styles.wide}>{effects[refund.effect]} — {money(refund.amountMinor,refund.currency)}.</p>
  {!credit&&<Field label="مرجع التحويل أو التنفيذ"><input value={reference} onChange={e=>setReference(e.target.value)} minLength={3} required/></Field>}
  <footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>تأكيد التنفيذ</button></footer>
 </form></Modal>;
}

export function CustomerCreditForm({credit,invoices,busy,onClose,onSave}){
 const eligible=invoices.filter(x=>x.type==='invoice'&&x.status==='issued'&&x.customerAccountId===credit.customerAccountId&&x.currency===credit.currency&&Number(x.outstandingMinor)>0);
 const [invoiceId,setInvoice]=useState(eligible[0]?.id||'');const [amount,setAmount]=useState('');
 return <Modal title="استخدام رصيد العميل" onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({creditId:credit.id,invoiceId,amountMinor:minor(amount)});}}>
  <p className={styles.wide}>المتاح: {money(credit.availableMinor,credit.currency)}. يُستخدم لصاحب الحساب نفسه وبالعملة نفسها.</p>
  <Field label="الفاتورة"><select value={invoiceId} onChange={e=>setInvoice(e.target.value)} required>{eligible.map(x=><option key={x.id} value={x.id}>{x.number} — {money(x.outstandingMinor,x.currency)}</option>)}</select></Field>
  <Field label="المبلغ"><input type="number" min="0.01" step="0.01" max={Number(credit.availableMinor)/100} value={amount} onChange={e=>setAmount(e.target.value)} required/></Field>
  <footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)||!eligible.length}>استخدام الرصيد</button></footer>
 </form></Modal>;
}

export function IncentiveAdjustmentForm({review,busy,onClose,onSave}){
 const [decision,setDecision]=useState('approved');const [reason,setReason]=useState('');
 return <Modal title="قرار مراجعة الحافز" onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({reviewId:review.id,decision,reason});}}>
  <p className={styles.wide}>التسوية المقترحة {money(Number(review.proposedReduction)*100)}. لن يُعدل الحافز الأصلي أو الراتب آليًا.</p>
  <Field label="القرار"><select value={decision} onChange={e=>setDecision(e.target.value)}><option value="approved">اعتماد للمراجعة المالية</option><option value="rejected">رفض التسوية</option></select></Field>
  <Field label="سبب القرار"><textarea value={reason} onChange={e=>setReason(e.target.value)} minLength={3} required/></Field>
  <footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>حفظ القرار</button></footer>
 </form></Modal>;
}
