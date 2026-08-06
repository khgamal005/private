'use client';

import {useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';

const EMPTY=[];
const SOURCE={
  plan:'ضمن الباقة',
  subscription:'اشتراك مستقل',
  override:'تخصيص إداري',
  default:'افتراضي',
  none:'غير مفعّل'
};
const STATUS={
  included:'مشمولة',
  active:'نشطة',
  trialing:'تجريبية',
  pending:'بانتظار الموافقة',
  paused:'متوقفة',
  disabled:'غير مفعلة'
};
const METRIC={
  whatsapp_messages:'رسالة واتساب',
  email_messages:'رسالة بريد',
  zoom_meetings:'اجتماع Zoom',
  automation_runs:'تشغيل قاعدة',
  active_templates:'قالب نشط',
  delivery_events:'إشعار تسليم',
  api_calls:'طلب API'
};

export default function AddonCenter({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const products=data.products||EMPTY;
  const usage=data.recentUsage||EMPTY;
  const summary=data.summary||{};
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  async function action(name,product){
    setBusy(`${name}-${product.key}`);setNotice('');setError('');
    try{
      const response=await fetch('/api/tenant/addon-center',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:name,
          p_payload:{productKey:product.key}
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ الطلب');
      setNotice(name==='request_trial'
        ?'تم إرسال طلب التجربة للإدارة المركزية دون تفعيل مدفوع تلقائي.'
        :'تم إلغاء الطلب المعلق.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  return <section className="mt-addon-center">
    <section className="mt-kpis mt-addon-kpis">
      <article className="mt-kpi"><span>الإضافات المتاحة</span><b>{summary.products||0}</b><small>كل إضافة مستقلة تقنيًا</small></article>
      <article className="mt-kpi success"><span>المفعّل</span><b>{summary.enabled||0}</b><small>من الباقة أو اشتراك مستقل</small></article>
      <article className="mt-kpi"><span>طلبات معلقة</span><b>{summary.pending||0}</b><small>تحتاج موافقة مركزية</small></article>
      <article className="mt-kpi"><span>تجارب نشطة</span><b>{summary.trialing||0}</b><small>بمدة وحد استخدام موثقين</small></article>
    </section>

    <section className="mt-addon-principle">
      <span>◈</span><div><b>بنية إضافات حقيقية</b><p>التفعيل منفصل عن الواجهة، والاستهلاك يُحجز قبل استدعاء المزود ثم يُحتسب فقط عند نجاح الإرسال؛ المحاكاة والفشل لا يُفوتران.</p></div>
    </section>
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <section className="mt-addon-grid">
      {products.map(product=>{
        const entitlement=product.entitlement||{};
        const enabled=Boolean(entitlement.enabled);
        const pending=entitlement.status==='pending';
        const used=Number(entitlement.used||0);
        const reserved=Number(entitlement.reserved||0);
        const limit=entitlement.limit==null?null:Number(entitlement.limit);
        const percent=limit?Math.min(100,Math.round(100*(used+reserved)/limit)):0;
        return <article className={`mt-addon-card ${enabled?'enabled':''}`} key={product.id}>
          <header>
            <div><small>{product.featureKey}</small><h3>{product.name}</h3></div>
            <span className={enabled?'ready':pending?'warning':''}>{STATUS[entitlement.status]||'غير مفعلة'}</span>
          </header>
          <p>{product.description}</p>
          <div className="mt-addon-entitlement">
            <div><span>مصدر التفعيل</span><b>{SOURCE[entitlement.source]||entitlement.source}</b></div>
            <div><span>وحدة الاستخدام</span><b>{METRIC[product.metricKey]||product.metricKey}</b></div>
            <div><span>التسعير</span><b>{product.pricingMode==='contact_sales'?'حسب الاتفاق':'محدد'}</b></div>
          </div>
          <div className="mt-addon-usage">
            <div><span>الاستهلاك الحالي</span><b>{used}{reserved?` + ${reserved} محجوز`:''} / {limit==null?'غير محدود':limit}</b></div>
            <progress value={limit?percent:0} max="100"/>
            <small>{limit==null?'لا يوجد حد مفروض في النسخة الحالية؛ ما زال الاستهلاك مسجلًا.':`${Math.max(limit-used-reserved,0)} متبقي`}</small>
          </div>
          <footer>
            {enabled&&product.key==='yeastar'?<Link
              className="mt-button primary"
              href={`/tenant/${encodeURIComponent(slug)}/yeastar`}
            >فتح إضافة Yeastar</Link>
            :enabled?<span className="mt-addon-active-note">✓ جاهزة للاستخدام</span>
            :pending?<button className="mt-link-button danger" onClick={()=>action('cancel_request',product)} disabled={Boolean(busy)}>إلغاء الطلب</button>
            :<button className="mt-button primary" onClick={()=>action('request_trial',product)} disabled={Boolean(busy)}>
              {busy===`request_trial-${product.key}`?'جارٍ الإرسال…':`طلب تجربة ${product.trialDays} يومًا`}
            </button>}
          </footer>
        </article>;
      })}
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar"><div className="mt-segmented"><span>سجل الاستهلاك المحسوب</span></div><small>لا تُسجل المحاولة إلا بعد اعتماد المزود فعليًا</small></div>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>الإضافة</th><th>المقياس</th><th>الكمية</th><th>المصدر</th><th>الوقت</th></tr></thead>
        <tbody>{usage.map(item=><tr key={item.id}>
          <td><b>{item.name}</b></td><td>{METRIC[item.metricKey]||item.metricKey}</td><td>{item.quantity}</td><td>{item.sourceType}</td><td>{new Date(item.occurredAt).toLocaleString('ar-EG')}</td>
        </tr>)}</tbody>
      </table>{!usage.length&&<div className="mt-empty">لا يوجد استهلاك مدفوع حتى الآن؛ عمليات البوابة التجريبية لا تُحتسب.</div>}</div>
    </section>
  </section>;
}
