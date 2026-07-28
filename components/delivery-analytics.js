'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];
const STATE={
  accepted:'قبله المزود',
  delivered:'تم التسليم',
  read:'تمت القراءة',
  simulated:'محاكاة — لم يُرسل',
  failed:'فشل',
  bounced:'مرتد',
  complained:'شكوى'
};
const CHANNEL={whatsapp:'واتساب',email:'البريد الإلكتروني'};

export default function DeliveryAnalytics({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const summary=data.summary||{};
  const webhooks=data.webhooks||EMPTY;
  const events=data.recentEvents||EMPTY;
  const channels=data.channels||EMPTY;
  const [credential,setCredential]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  if(data.locked)return <section className="mt-addon-locked">
    <span>◇</span><div><h3>إضافة إثبات التسليم غير مفعّلة</h3><p>فعّلها من «الإضافات والاشتراك» لفتح Webhooks الموقعة والتحليلات.</p></div>
  </section>;

  async function action(name,payload){
    const response=await fetch('/api/tenant/delivery-analytics',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        p_slug:slug,
        p_action:name,
        p_payload:payload
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تحديث Webhook');
    return result.data;
  }

  async function rotate(webhook){
    if(!window.confirm('سيُلغى المفتاح السابق فورًا. هل تريد إنشاء مفتاح جديد؟'))return;
    setBusy(`rotate-${webhook.id}`);setError('');setNotice('');
    try{
      const result=await action('rotate_webhook',{
        connectionId:webhook.connectionId
      });
      setCredential({
        ...result,
        connectionName:webhook.connectionName
      });
      setNotice('تم تدوير المفتاح. سيظهر مرة واحدة فقط.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function toggle(webhook){
    const actionName=webhook.status==='active'
      ?'pause_webhook'
      :'enable_webhook';
    setBusy(`toggle-${webhook.id}`);setError('');setNotice('');
    try{
      await action(actionName,{connectionId:webhook.connectionId});
      setNotice(actionName==='pause_webhook'
        ?'تم إيقاف استقبال إشعارات هذا المزود.'
        :'تم تفعيل استقبال إشعارات هذا المزود.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function copy(value,label){
    await navigator.clipboard.writeText(value);
    setNotice(`تم نسخ ${label}.`);
  }

  const cost=(Number(summary.costMinor||0)/100).toLocaleString('ar-EG',{
    minimumFractionDigits:2,
    maximumFractionDigits:2
  });

  return <section className="mt-delivery-analytics">
    <section className="mt-kpis mt-delivery-kpis">
      <article className="mt-kpi"><span>الرسائل</span><b>{summary.messages||0}</b><small>آخر {data.days||30} يومًا</small></article>
      <article className="mt-kpi success"><span>نسبة التسليم</span><b>{summary.deliveryRate||0}%</b><small>{summary.delivered||0} تسليمًا مثبتًا</small></article>
      <article className="mt-kpi"><span>القراءة</span><b>{summary.read||0}</b><small>وفق ما يرجعه المزود</small></article>
      <article className="mt-kpi"><span>مرتد أو فاشل</span><b>{summary.failed||0}</b><small>{summary.bounced||0} مرتد · {summary.complained||0} شكوى</small></article>
      <article className="mt-kpi"><span>التكلفة المثبتة</span><b>{cost}</b><small>{summary.currency||'SAR'} · من Webhooks فقط</small></article>
    </section>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <section className="mt-delivery-channel-grid">
      {channels.map(channel=><article key={channel.channel}>
        <header><b>{CHANNEL[channel.channel]||channel.channel}</b><span>{channel.messages} رسالة</span></header>
        <div><span>تم التسليم <b>{channel.delivered}</b></span><span>فشل <b>{channel.failed}</b></span><span>محاكاة <b>{channel.simulated}</b></span></div>
      </article>)}
      {!channels.length&&<div className="mt-empty">لا توجد رسائل في الفترة المحددة.</div>}
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented"><span>Webhooks إثبات التسليم</span></div>
        <small>توقيع HMAC، نافذة زمنية 5 دقائق، ومنع تكرار حدث المزود</small>
      </div>
      <div className="mt-delivery-webhook-grid">
        {webhooks.map(webhook=><article key={webhook.id}>
          <header>
            <div><small>{webhook.providerKey}</small><h4>{webhook.connectionName}</h4></div>
            <span className={`mt-provider-state ${webhook.status==='active'?'ready':'warning'}`}>
              {webhook.status==='active'?'يستقبل':'متوقف'}
            </span>
          </header>
          <dl>
            <div><dt>القناة</dt><dd>{CHANNEL[webhook.channel]||webhook.channel}</dd></div>
            <div><dt>آخر استلام</dt><dd>{webhook.lastReceivedAt?new Date(webhook.lastReceivedAt).toLocaleString('ar-EG'):'لم يستقبل بعد'}</dd></div>
          </dl>
          <p>أرسل `webhookId` داخل JSON، ووقّع النص الخام باستخدام المفتاح المشفر.</p>
          <footer>
            <button className="mt-link-button" onClick={()=>toggle(webhook)} disabled={Boolean(busy)}>
              {webhook.status==='active'?'إيقاف الاستقبال':'تفعيل الاستقبال'}
            </button>
            <button className="mt-button primary" onClick={()=>rotate(webhook)} disabled={Boolean(busy)}>
              {busy===`rotate-${webhook.id}`?'جارٍ التدوير…':'تدوير المفتاح'}
            </button>
          </footer>
        </article>)}
      </div>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented"><span>دليل التسليم الأخير</span></div>
        <small>لا نخزن نص الرسالة أو بيانات المستفيد داخل إشعار المزود</small>
      </div>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>الحالة</th><th>المزود</th><th>القناة</th><th>الربط</th><th>التكلفة</th><th>الوقت</th></tr></thead>
        <tbody>{events.map(event=><tr key={event.id}>
          <td><span className={`mt-delivery-state ${event.state}`}>{STATE[event.state]||event.state}</span></td>
          <td><b>{event.providerKey}</b>{event.detail&&<small>{event.detail}</small>}</td>
          <td>{CHANNEL[event.channel]||event.channel}</td>
          <td>{event.matched?'مرتبطة برسالة':'غير مطابقة'}</td>
          <td>{event.billable?`${(Number(event.costMinor||0)/100).toFixed(2)} ${event.currency}`:'غير محتسبة'}</td>
          <td>{new Date(event.occurredAt).toLocaleString('ar-EG')}</td>
        </tr>)}</tbody>
      </table>{!events.length&&<div className="mt-empty">لم تصل إشعارات تسليم بعد.</div>}</div>
    </section>

    {credential&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>setCredential(null)}/>
      <section className="mt-modal mt-delivery-secret-modal">
        <header><div><small>ONE-TIME WEBHOOK SECRET</small><h3>{credential.connectionName}</h3></div><button onClick={()=>setCredential(null)}>×</button></header>
        <div className="mt-delivery-secret-body">
          <div className="mt-alert">انسخ المفتاح الآن؛ لن يعرضه النظام مرة أخرى.</div>
          <label>Endpoint<div><input readOnly value={credential.endpoint}/><button className="mt-button" onClick={()=>copy(credential.endpoint,'الرابط')}>نسخ</button></div></label>
          <label>Webhook ID<div><input readOnly value={credential.webhookId}/><button className="mt-button" onClick={()=>copy(credential.webhookId,'المعرّف')}>نسخ</button></div></label>
          <label>Signing secret<div><input readOnly value={credential.secret}/><button className="mt-button primary" onClick={()=>copy(credential.secret,'المفتاح')}>نسخ</button></div></label>
          <p>التوقيع: `sha256=HMAC_SHA256(secret, timestamp + &quot;.&quot; + rawBody)` مع ترويسة `x-marktone-timestamp`.</p>
        </div>
        <footer><button className="mt-button primary" onClick={()=>setCredential(null)}>حفظت المفتاح</button></footer>
      </section>
    </div>}
  </section>;
}
