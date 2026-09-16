'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {formatGoogleMetric,googleErrorMessage,requestGoogleAction} from '../lib/google-ads/ui.mjs';
import {ga4StatusLabels,ga4AmountLabels,ga4Insights,ga4Csv} from '../lib/google-ads/ga4-ui.mjs';
import styles from './google-ads-connect.module.css';
const number=value=>formatGoogleMetric(value);
const money=(value,currency)=>formatGoogleMetric(value,{money:true,currency});
function Metric({label,value,note}){return <article className={styles.metric}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;}
export default function GoogleGA4Report({slug,filters,canManage,connected,display='report'}) {
 const settings=display==='settings';
 const [config,setConfig]=useState(null),[report,setReport]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [propertyId,setPropertyId]=useState(''),[connectionId,setConnectionId]=useState(''),[editing,setEditing]=useState(false),[page,setPage]=useState(1),[status,setStatus]=useState('all'),[campaignId,setCampaignId]=useState('');
 const generation=useRef(0);
 const from=filters.dateFrom,to=filters.dateTo,asOf=filters.asOf;
 const request=(name,payload={},signal)=>requestGoogleAction({name,slug,payload,signal});
 useEffect(()=>{
  const controller=new AbortController();const current=++generation.current;setError('');setReport(null);setBusy('load');
  requestGoogleAction({name:'ga4-status',slug,signal:controller.signal}).then(async c=>[c,!settings&&c.configured?await requestGoogleAction({name:'ga4-report',slug,payload:{dateFrom:from,dateTo:to,asOf,page,status,campaignId},signal:controller.signal}):null])
   .then(([c,r])=>{if(controller.signal.aborted||current!==generation.current)return;setConfig(c);setReport(r);})
   .catch(e=>{if(e.name!=='AbortError'&&current===generation.current)setError(googleErrorMessage(e.message));})
   .finally(()=>{if(!controller.signal.aborted&&current===generation.current)setBusy('');});
  return ()=>{controller.abort();};
 },[slug,from,to,asOf,page,status,campaignId,connected,settings]);
 async function action(name,payload={}) {
  if(!canManage||busy)return;const current=++generation.current;setBusy(name);setError('');setNotice('');
  try {
   const result=await request(name,{commandId:crypto.randomUUID(),...payload});
   if(name==='start'){window.location.assign(result.authorizeUrl);return;}
   if(result.status==='failed'||result.status==='superseded')throw new Error('sync_failed');
   if(result.status==='running'){setNotice('المزامنة جارية؛ حدّث التقرير بعد قليل.');return;}
   const [c,r]=await Promise.all([request('ga4-status'),settings?null:request('ga4-report',{dateFrom:from,dateTo:to,asOf,page,status,campaignId})]);
   if(current!==generation.current)return;setConfig(c);setReport(r);
   if(name==='ga4-assets')setEditing(true);
   if(name==='ga4-select'){setEditing(false);setNotice('تم حفظ الخاصية والمتجر. اضغط «مزامنة GA4» لجلب الفترة المختارة.');}
   if(name==='ga4-sync')setNotice('اكتملت مزامنة GA4 والمطابقة مع أحدث سجلات أودير.');
  }catch(e){if(current===generation.current)setError(googleErrorMessage(e.message));}
  finally{if(current===generation.current)setBusy('');}
 }
 function exportPage(){const blob=new Blob([ga4Csv(report.rows||[])],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`ga4-orders-${from}-page-${page}.csv`;a.click();URL.revokeObjectURL(url);}
 const c=report?.coverage||{},s=report?.summary||{},traffic=report?.traffic||{};
 const rate=s.transactions?100*s.matchedOrders/s.transactions:null;
 return <section className={styles.panel} aria-busy={Boolean(busy)} aria-labelledby="ga4-title">
  <header className={styles.sectionHead}><div><span className={styles.eyebrow}>ضمن إضافة Google Kit</span><h2 id="ga4-title">{settings?'ربط Google Analytics (GA4)':'المتجر: من الزيارة إلى التحصيل'}</h2><p>GA4 يوضح ما حدث في المتجر، وأودير يثبت الطلب والتسجيل والتحصيل.</p></div><span className={`${styles.badge} ${config?.configured&&config?.consentGranted&&connected?styles.connected:styles.pending}`}>{config?.configured?(config?.consentGranted&&connected?'GA4 متصل':'يحتاج إعادة ربط'):'موصل GA4'}</span></header>
  {error?<p className={`${styles.feedback} ${styles.error}`} role="alert">{error}</p>:null}{notice?<p className={styles.feedback} role="status">{notice}</p>:null}
  {settings&&canManage?<div className={styles.actions}>
   {!config?.consentGranted?<button className={styles.primary} disabled={Boolean(busy)} onClick={()=>action('start',{includeAnalytics:true})}>ربط GA4 مع جوجل</button>:<button className={styles.secondary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-assets')}>{config?.configured?'تغيير الخاصية أو المتجر':'اختيار الخاصية والمتجر'}</button>}
   {config?.configured?<><button className={styles.primary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-sync',{dateFrom:from,dateTo:to})}>{busy==='ga4-sync'?'جارٍ جلب البيانات…':'مزامنة GA4'}</button><button className={styles.textButton} disabled={Boolean(busy)} onClick={()=>action('ga4-disable')}>إيقاف موصل GA4</button></>:null}
  </div>:null}
  {!config?.configured?<p className={styles.note}>اختر خاصية Analytics ومتجر المنشأة مرة واحدة. يعمل الموصل ضمن اشتراك Google Kit، دون شراء إضافة Analytics أخرى.</p>:<p className={styles.note}>{config.property?.name} · <span dir="ltr">{config.property?.hostname}</span> · توقيت القياس: <span dir="ltr">{config.property?.timezone}</span></p>}
  {settings&&editing&&canManage?<form className={styles.reviewFields} onSubmit={e=>{e.preventDefault();action('ga4-select',{propertyId,connectionId});}}>
   <label>خاصية GA4<select required value={propertyId} onChange={e=>setPropertyId(e.target.value)}><option value="">اختر الخاصية</option>{(config?.properties||[]).map(p=><option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label>
   <label>متجر المنشأة<select required value={connectionId} onChange={e=>setConnectionId(e.target.value)}><option value="">اختر المتجر</option>{(config?.stores||[]).map(p=><option key={p.id} value={p.id}>{p.url}</option>)}</select></label>
   {!config?.stores?.length?<p>اربط متجر WooCommerce من إعدادات المنشأة أولًا.</p>:null}
   <button className={styles.primary} disabled={Boolean(busy)||!propertyId||!connectionId}>حفظ الربط</button><button type="button" className={styles.secondary} onClick={()=>setEditing(false)}>إلغاء</button>
  </form>:null}
  {!settings&&config?.configured&&canManage?<button type="button" className={styles.secondary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-sync',{dateFrom:from,dateTo:to})}>{busy==='ga4-sync'?'جارٍ المزامنة…':'مزامنة GA4 السريعة'}</button>:null}
  {!settings&&!config?.configured&&busy!=='load'?<Link className={styles.secondary} href={`/tenant/${encodeURIComponent(slug)}/addons/google-kit`}>إعداد Google Analytics</Link>:null}
  {!settings&&report?.configured?<>
   <p className={styles.note}>الطلبات بحسب تاريخ حدث الشراء في GA4، والتحصيل حتى {asOf}. إسناد الحملة بحسب جلسة الشراء المسجلة في Google. هذه النتائج مستقلة عن المطابقة اليدوية أعلاه وقد تتقاطع معها؛ لا تجمع المجموعتين.</p>
   <p className={styles.note}>{c.complete?'اكتملت قراءة الفترة':'أيام غير متزامنة: '+number(c.missingDays)} · آخر مزامنة: {c.latestSync?new Date(c.latestSync).toLocaleString('ar-EG'):'لم تتم بعد'}{c.transactionDataLimited||c.trafficDataLimited?' · Google أعاد بيانات محدودة':''}</p>
   <div className={styles.metrics}>
    <Metric label="جلسات المتجر" value={number(traffic.sessions)} note="قياس GA4 ضمن النطاق المختار"/>
    <Metric label="جلسات متفاعلة" value={number(traffic.engagedSessions)} note={traffic.sessions?`${formatGoogleMetric(100*traffic.engagedSessions/traffic.sessions,{digits:1})}% من الجلسات`:undefined}/>
    <Metric label="بدء الدفع" value={number(traffic.checkouts)} note="عدد أحداث بدء الدفع؛ ليس عدد الطلاب"/>
    <Metric label="معاملات الشراء" value={number(s.transactions)} note="معرّفات معاملات GA4 الفريدة"/>
    <Metric label="طلبات مطابقة" value={number(s.matchedOrders)} note={rate!==null?`${formatGoogleMetric(rate,{digits:1})}% من معاملات GA4 المتاحة`:'لا توجد معاملات للمقارنة'}/>
    <Metric label="طلبات بدفع معتمد" value={number(s.verifiedOrders)} note="وفق سجلات التحصيل في أودير"/>
    <Metric label="تسجيلات بدفع معتمد" value={number(s.verifiedRegistrations)} note="قد يشمل الطلب أكثر من تسجيل"/>
    <Metric label="تحتاج مراجعة" value={number((s.unmatched||0)+(s.pendingPayments||0))} note="مطابقة ناقصة أو دفع لم يُعتمد"/>
   </div>
   {(report.finances||[]).map(f=><div className={styles.metrics} key={f.currency}><Metric label={`التحصيل المعتمد · ${f.currency}`} value={money(f.collectionsMinor,f.currency)}/><Metric label="استردادات مكتملة" value={money(f.refundsMinor,f.currency)}/><Metric label="صافي التحصيل المطابق" value={money(f.netMinor,f.currency)} note="أقساط وتحويلات مثبتة مرة واحدة"/></div>)}
   <div className={styles.reviewPreview}><b>ما الذي يحتاج اهتمامك؟</b><ul>{ga4Insights(report).map(text=><li key={text}>{text}</li>)}</ul></div>
   <details className={styles.details}><summary>الحملات ومعاملات المتجر ودليل المطابقة</summary>
   {report.campaigns?.length?<div className={styles.tableWrap}><table className={styles.table}><caption>نتائج الطلبات حسب حملة جلسة الشراء؛ لا تمثل تكلفة اكتساب طالب جديد.</caption><thead><tr><th>الحملة</th><th>طلبات</th><th>دفع معتمد</th><th>تسجيلات معتمدة الدفع</th><th>صافي التحصيل</th></tr></thead><tbody>{report.campaigns.map(row=><tr key={row.id}><th><button className={styles.textButton} onClick={()=>{setCampaignId(row.id);setPage(1);}}>{row.name||row.id}</button></th><td data-label="الطلبات">{number(row.orders)}</td><td data-label="دفع معتمد">{number(row.verifiedOrders)}</td><td data-label="التسجيلات">{number(row.verifiedRegistrations)}</td><td data-label="صافي التحصيل">{row.finances?.length?row.finances.map(f=><div key={f.currency}>{money(f.netMinor,f.currency)}</div>):'غير متاح'}</td></tr>)}</tbody></table></div>:null}
   <div className={styles.actions}><label>حالة المطابقة <select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="all">كل الحالات</option><option value="verified">دفع معتمد</option><option value="payment_pending">ينتظر الدفع</option><option value="unmatched">تحتاج مطابقة</option></select></label>{campaignId?<button className={styles.secondary} onClick={()=>{setCampaignId('');setPage(1);}}>كل الحملات</button>:null}{report.canReadDetails&&report.rows?.length?<button className={styles.secondary} onClick={exportPage}>تصدير الصفحة CSV</button>:null}</div>
   {report.canReadDetails?<><div className={styles.tableWrap}><table className={styles.table}><caption>دليل المطابقة لكل معاملة — حتى ٥٠ صفًا في الصفحة</caption><thead><tr><th>المعاملة / الطلب</th><th>المصدر والحملة</th><th>المطابقة</th><th>التسجيلات</th>{report.canReadMoney?<><th>صافي التحصيل</th><th>مراجعة القيمة</th></>:null}</tr></thead><tbody>{(report.rows||[]).map(row=><tr key={row.transactionId}><th><span dir="ltr">{row.transactionId}</span><small>{row.date} · طلب {row.orderNumber||'—'}</small></th><td data-label="المصدر والحملة">{row.source} / {row.medium}<small>{row.campaignName}</small></td><td data-label="المطابقة">{ga4StatusLabels[row.status]||row.status}</td><td data-label="التسجيلات">{number(row.verifiedRegistrations)}</td>{report.canReadMoney?<><td data-label="صافي التحصيل">{money(row.netMinor,row.currency)}</td><td data-label="مراجعة القيمة">{ga4AmountLabels[row.amountCheck]||'—'}</td></>:null}</tr>)}</tbody></table></div><nav className={styles.pagination} aria-label="صفحات معاملات GA4"><button className={styles.secondary} disabled={page===1||Boolean(busy)} onClick={()=>setPage(p=>p-1)}>السابق</button><span>{number(page)} · {number(report.totalRows)} معاملة</span><button className={styles.secondary} disabled={!report.hasMore||Boolean(busy)} onClick={()=>setPage(p=>p+1)}>التالي</button></nav></>:<p className={styles.note}>تفاصيل الطلبات متاحة لمن لديه صلاحية قراءة العملاء.</p>}
   </details>
  </>:busy==='load'?<p className={styles.note}>جارٍ تحميل حالة التتبع…</p>:null}
 </section>;
}

