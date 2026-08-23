'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-marketplace.module.css';

const EMPTY=[];
const STATUS={
  pending_payment:'بانتظار الدفع',
  paid:'مدفوع',
  in_progress:'قيد التنفيذ',
  completed:'مكتمل',
  cancelled:'ملغي',
  refunded:'مسترد'
};

function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency,
    maximumFractionDigits:2
  }).format((Number(amountMinor)||0)/100);
}
function date(value){
  return value?new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',
    timeStyle:'short'
  }).format(new Date(value)):'—';
}

export default function PlatformMarketplace({initialData}){
  const router=useRouter();
  const data=initialData||{};
  const orders=data.orders||EMPTY;
  const [filter,setFilter]=useState('open');
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [paymentOrder,setPaymentOrder]=useState(null);
  const [paymentReference,setPaymentReference]=useState('');
  const [webhookSecret,setWebhookSecret]=useState(null);

  const visibleOrders=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return orders.filter(order=>{
      const filterMatch=filter==='all'
        ||(filter==='open'&&['pending_payment','paid','in_progress'].includes(order.status))
        ||(filter==='addons'&&order.kind==='addon')
        ||(filter==='services'&&order.kind==='service');
      const queryMatch=!needle||[
        order.orderNumber,order.tenantName,order.tenantSlug,
        ...(order.items||EMPTY).map(item=>item.name)
      ].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle));
      return filterMatch&&queryMatch;
    });
  },[orders,filter,query]);

  async function action(pAction,pPayload,message){
    const key=pAction+'-'+(pPayload.orderId||'global');
    setBusy(key);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/platform/marketplace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({p_action:pAction,p_payload:pPayload})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
      if(pAction==='rotate_webhook_secret')setWebhookSecret(result.data);
      setNotice(message||'تم تنفيذ العملية بنجاح.');
      router.refresh();
      return true;
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر تنفيذ العملية');
      return false;
    }finally{
      setBusy('');
    }
  }

  async function confirmPayment(event){
    event.preventDefault();
    if(!paymentOrder)return;
    const done=await action('confirm_payment',{
      orderId:paymentOrder.id,
      reference:paymentReference.trim()||'beta-manual-confirmation'
    },paymentOrder.kind==='addon'
      ?'تم تأكيد الدفع وتفعيل الإضافة تلقائيًا للمنشأة.'
      :'تم تأكيد الدفع وتحويل الخدمة إلى فريق التنفيذ.');
    if(done){
      setPaymentOrder(null);
      setPaymentReference('');
    }
  }

  const summary=data.summary||{};
  return <section className={styles.page}>
    <header className={styles.hero}>
      <div><span>MARKTONE MARKETPLACE</span><h1>متجر الخدمات والإضافات</h1><p>إدارة الطلبات، تأكيد المدفوعات، متابعة تنفيذ الخدمات، ومراقبة التفعيل التلقائي للإضافات.</p></div>
      <button
        type="button"
        disabled={Boolean(busy)}
        onClick={()=>action('rotate_webhook_secret',{},'تم إنشاء سر Webhook جديد؛ سيظهر مرة واحدة فقط.')}
      >تهيئة Webhook الدفع</button>
    </header>

    <section className={styles.kpis}>
      <article><small>إجمالي الطلبات</small><b>{summary.totalOrders||0}</b></article>
      <article><small>بانتظار الدفع</small><b>{summary.pendingPayment||0}</b></article>
      <article><small>خدمات قيد التنفيذ</small><b>{summary.paidServices||0}</b></article>
      <article><small>إضافات تم تفعيلها</small><b>{summary.activatedAddons||0}</b></article>
      <article><small>إجمالي المدفوع</small><b>{money(summary.revenueMinor||0)}</b></article>
    </section>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {webhookSecret&&<section className={styles.secret}>
      <header><div><small>يظهر مرة واحدة</small><h2>بيانات Webhook الدفع</h2></div><button type="button" onClick={()=>setWebhookSecret(null)}>×</button></header>
      <p>استخدم السر في موصل بوابة الدفع لتوقيع: <code>timestamp.rawBody</code> بخوارزمية HMAC-SHA256.</p>
      <label><span>المسار</span><code>{webhookSecret.endpointPath}</code></label>
      <label><span>السر</span><code>{webhookSecret.secret}</code></label>
      <small>عند مغادرة هذه الشاشة لن يعرض أودير السر مرة أخرى. تدويره يبطل السر السابق فورًا.</small>
    </section>}

    <section className={styles.toolbar}>
      <div>
        {[
          ['open','المفتوحة'],
          ['services','الخدمات'],
          ['addons','الإضافات'],
          ['all','الكل']
        ].map(([key,label])=><button
          key={key}
          type="button"
          className={filter===key?styles.active:''}
          onClick={()=>setFilter(key)}
        >{label}</button>)}
      </div>
      <input aria-label="البحث في طلبات المتجر" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالمنشأة أو الطلب أو المنتج…"/>
    </section>

    <section className={styles.orders}>
      <header>
        <span>الطلب</span><span>المنشأة</span><span>النوع والحالة</span><span>القيمة</span><span>الإجراء</span>
      </header>
      {visibleOrders.map(order=><article key={order.id}>
        <div><b>{order.orderNumber}</b><small>{order.items?.map(item=>item.name).join('، ')}</small><em>{date(order.createdAt)}</em></div>
        <div><b>{order.tenantName}</b><small>{order.tenantSlug}</small></div>
        <div><span className={styles.kind}>{order.kind==='addon'?'إضافة':'خدمة'}</span><span className={[styles.status,styles[order.status]||''].join(' ')}>{STATUS[order.status]||order.status}</span></div>
        <div><b>{money(order.totalMinor,order.currency)}</b><small>{order.paymentStatus==='paid'?'مدفوع':'غير مدفوع'}</small></div>
        <div className={styles.actions}>
          {order.status==='pending_payment'&&<button type="button" onClick={()=>{setPaymentOrder(order);setPaymentReference('');}}>تأكيد الدفع</button>}
          {order.kind==='service'&&order.status==='paid'&&<button
            type="button"
            disabled={Boolean(busy)}
            onClick={()=>action('update_service_status',{orderId:order.id,status:'in_progress'},'تم بدء تنفيذ الخدمة.')}
          >بدء التنفيذ</button>}
          {order.kind==='service'&&order.status==='in_progress'&&<button
            type="button"
            disabled={Boolean(busy)}
            onClick={()=>action('update_service_status',{orderId:order.id,status:'completed'},'تم إغلاق الخدمة كمكتملة.')}
          >إكمال الخدمة</button>}
          {order.kind==='addon'&&order.activationState==='active'&&<span className={styles.activated}>✓ تفعيل تلقائي</span>}
        </div>
      </article>)}
      {!visibleOrders.length&&<div className={styles.empty}>لا توجد طلبات مطابقة للفلتر الحالي.</div>}
    </section>

    <section className={styles.catalogs}>
      <article><header><h2>كتالوج الخدمات</h2><span>{data.services?.length||0}</span></header>{(data.services||EMPTY).map(item=><div key={item.key}><span><b>{item.name}</b><small>{item.categoryName} · {item.unitLabel}</small></span><strong>{money(item.amountMinor,item.currency)}</strong></div>)}</article>
      <article><header><h2>كتالوج الإضافات</h2><span>{data.addons?.length||0}</span></header>{(data.addons||EMPTY).map(item=><div key={item.key}><span><b>{item.name}</b><small>{item.interval==='month'?'شهري':'مرة واحدة'}</small></span><strong>{money(item.amountMinor,item.currency)}</strong></div>)}</article>
    </section>

    {paymentOrder&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} aria-label="إغلاق" onClick={()=>setPaymentOrder(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="payment-confirmation-title" onSubmit={confirmPayment}>
        <header><div><small>تأكيد تحصيل</small><h2 id="payment-confirmation-title">{paymentOrder.orderNumber}</h2></div><button type="button" aria-label="إغلاق" onClick={()=>setPaymentOrder(null)}>×</button></header>
        <p>سيتم تسجيل دفعة بقيمة <b>{money(paymentOrder.totalMinor,paymentOrder.currency)}</b>. {paymentOrder.kind==='addon'?'وبمجرد التأكيد ستُفعّل الإضافة تلقائيًا داخل منشأة '+paymentOrder.tenantName+'.':''}</p>
        <label><span>مرجع عملية الدفع</span><input required maxLength="200" value={paymentReference} onChange={event=>setPaymentReference(event.target.value)} placeholder="رقم التحويل أو مرجع البوابة"/></label>
        <aside>هذا المسار احتياطي للبيتا. في التشغيل الآلي ينفذ Webhook الموقّع نفس الإجراء دون تدخل بشري.</aside>
        <footer><button type="button" onClick={()=>setPaymentOrder(null)}>إلغاء</button><button className={styles.primary} type="submit" disabled={Boolean(busy)}>تأكيد الدفع</button></footer>
      </form>
    </div>}
  </section>;
}
