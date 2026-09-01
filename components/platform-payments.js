'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-commerce.module.css';

const EMPTY=[];
const money=(minor,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency,maximumFractionDigits:2}).format((Number(minor)||0)/100);
const date=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'}).format(new Date(value)):'—';
const STATE={paid:'ناجحة',failed:'فاشلة',refunded:'مستردة',pending_payment:'بانتظار الدفع'};

export default function PlatformPayments({initialData}){
  const router=useRouter();
  const payments=initialData?.payments||EMPTY;
  const orders=initialData?.orders||EMPTY;
  const [tab,setTab]=useState('transactions');
  const [query,setQuery]=useState('');
  const [paymentOrder,setPaymentOrder]=useState(null);
  const [reference,setReference]=useState('');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const summary=initialData?.summary||{};
  const rows=useMemo(()=>{const needle=query.trim().toLocaleLowerCase('ar');const source=tab==='pending'?orders.filter(order=>order.paymentStatus==='pending'):payments;return source.filter(item=>!needle||[item.orderNumber,item.tenantName,item.providerKey,item.reference,item.state,...(item.items||EMPTY).map(entry=>entry.name)].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle)))},[tab,query,orders,payments]);

  async function confirm(event){event.preventDefault();if(!paymentOrder)return;setBusy(true);setError('');try{const response=await fetch('/api/platform/marketplace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_action:'confirm_payment',p_payload:{orderId:paymentOrder.id,reference:reference.trim()}})});const result=await response.json();if(!response.ok)throw new Error(result.error||'تعذر تأكيد الدفع');setPaymentOrder(null);setReference('');setNotice(paymentOrder.kind==='addon'?'تم تسجيل الدفعة وتفعيل الإضافة تلقائيًا للمنشأة.':'تم تسجيل الدفعة وتحويل الخدمة للتنفيذ.');router.refresh()}catch(err){setError(err.message)}finally{setBusy(false)}}

  return <section className={styles.page}>
    <header className={styles.hero}><div><small>PAYMENTS & COLLECTION</small><h1>المدفوعات والتحصيل</h1><p>سجل مالي موحد لطلبات الإضافات والخدمات، مع التحقق من التوقيع، مرجع البوابة، والمدفوعات التي ما زالت تنتظر التحصيل.</p></div></header>
    <section className={styles.kpis}><article><span>إجمالي المحصل</span><b>{money(summary.paidRevenueMinor||0)}</b><small>طلبات مدفوعة</small></article><article className={summary.pendingPayments?styles.warning:''}><span>بانتظار الدفع</span><b>{summary.pendingPayments||0}</b><small>تحتاج متابعة</small></article><article><span>عمليات مسجلة</span><b>{payments.length}</b><small>ناجحة وفاشلة ومستردة</small></article><article><span>إيراد شهري متكرر</span><b>{money(summary.monthlyRecurringMinor||0)}</b><small>من اشتراكات الباقات</small></article></section>
    {notice&&<div className={styles.notice}>{notice}</div>}{error&&<div className={styles.error}>{error}</div>}
    <nav className={styles.tabs}><button className={tab==='transactions'?styles.active:''} onClick={()=>setTab('transactions')}>سجل العمليات</button><button className={tab==='pending'?styles.active:''} onClick={()=>setTab('pending')}>طلبات تنتظر الدفع</button></nav>
    <div className={styles.toolbar}><div className={styles.toolbarTitle}><b>{tab==='transactions'?'الحركات المالية':'الطلبات غير المحصلة'}</b><small>{rows.length} سجل</small></div><input className={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالمنشأة أو المرجع…"/></div>
    <section className={styles.orders}><div className={styles.orderHeader}><span>العملية / الطلب</span><span>المنشأة</span><span>الحالة</span><span>القيمة</span><span>التحقق والإجراء</span></div>{rows.map(item=><div className={styles.order} key={item.id}><div><b>{item.orderNumber}</b><small>{tab==='pending'?item.items?.map(entry=>entry.name).join('، '):item.reference||item.providerEventId}</small></div><div><b>{item.tenantName}</b><small>{tab==='pending'?item.tenantSlug:item.providerKey}</small></div><span className={`${styles.status} ${styles[item.state||item.status]||''}`}>{STATE[item.state||item.status]||item.state||item.status}</span><div><b>{money(item.amountMinor??item.totalMinor,item.currency)}</b><small>{date(item.processedAt||item.createdAt)}</small></div><div className={styles.actions}>{tab==='transactions'?<span className={item.signatureVerified?styles.verified:styles.status}>{item.signatureVerified?'✓ توقيع موثّق':'إدخال يدوي'}</span>:item.paymentProvider==='paymob'?<span className={styles.status}>مطابقة Paymob فقط</span>:<button onClick={()=>{setPaymentOrder(item);setReference('')}}>تأكيد التحصيل</button>}</div></div>)}{!rows.length&&<div className={styles.empty}>لا توجد سجلات مطابقة.</div>}</section>
    {paymentOrder&&<div className={styles.modalLayer}><button className={styles.backdrop} aria-label="إغلاق" onClick={()=>!busy&&setPaymentOrder(null)}/><form className={styles.modal} onSubmit={confirm}><header><div><h2>تأكيد تحصيل {paymentOrder.orderNumber}</h2><p>{paymentOrder.tenantName} · {money(paymentOrder.totalMinor,paymentOrder.currency)}</p></div><button type="button" className={styles.close} onClick={()=>setPaymentOrder(null)}>×</button></header><div className={styles.form}><label className={`${styles.field} ${styles.wide}`}>مرجع عملية الدفع<input value={reference} onChange={event=>setReference(event.target.value)} required maxLength="200" placeholder="رقم التحويل أو مرجع بوابة الدفع"/></label><aside className={styles.hint}>{paymentOrder.kind==='addon'?'بعد التأكيد ستتفعّل الإضافة داخل هذه المنشأة فقط.':'بعد التأكيد سينتقل طلب الخدمة إلى فريق التنفيذ.'}</aside><footer className={styles.formFooter}><button type="button" className={styles.ghost} onClick={()=>setPaymentOrder(null)}>إلغاء</button><button className={styles.secondary} disabled={busy}>{busy?'جارٍ التأكيد…':'تأكيد الدفع'}</button></footer></div></form></div>}
  </section>;
}
