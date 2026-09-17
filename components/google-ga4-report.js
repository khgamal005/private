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
 const [streams,setStreams]=useState([]),[streamId,setStreamId]=useState(''),[streamsFor,setStreamsFor]=useState(''),[matchingOpen,setMatchingOpen]=useState(false);
 const generation=useRef(0);
 const from=filters.dateFrom,to=filters.dateTo,asOf=filters.asOf;
 const request=(name,payload={},signal)=>requestGoogleAction({name,slug,payload,signal});
 useEffect(()=>{
  const controller=new AbortController();const current=++generation.current;setError('');setReport(null);setBusy('load');
  requestGoogleAction({name:'ga4-status',slug,signal:controller.signal}).then(async c=>[c,!settings&&c.configured?await requestGoogleAction({name:'ga4-report',slug,payload:{dateFrom:from,dateTo:to,asOf,page,status,campaignId},signal:controller.signal}):null])
   .then(([c,r])=>{if(controller.signal.aborted||current!==generation.current)return;setConfig(c);setReport(r);})
   .catch(e=>{if(e.name!=='AbortError'&&current===generation.current)setError(e.message);})
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
   if(name==='ga4-streams'){
    if(current!==generation.current)return;
    if(!Array.isArray(result.streams))throw new Error('ga4_invalid_response');
    setStreams(result.streams);setStreamsFor(payload.propertyId);
    setStreamId(result.streams.length===1?result.streams[0].id:result.streams.some(s=>s.id===config?.property?.streamId)?config.property.streamId:'');
    return;
   }
   const [c,r]=await Promise.all([request('ga4-status'),settings?null:request('ga4-report',{dateFrom:from,dateTo:to,asOf,page,status,campaignId})]);
   if(current!==generation.current)return;setConfig(c);setReport(r);
   if(name==='ga4-assets'){
    setEditing(true);setMatchingOpen(false);setStreams([]);setStreamsFor('');setStreamId('');
    const chosen=(c.properties||[]).find(p=>p.id===c.property?.id)?.id||(c.properties?.length===1?c.properties[0].id:'');
    setPropertyId(chosen);
    if(chosen){
     const found=await request('ga4-streams',{commandId:crypto.randomUUID(),propertyId:chosen});
     if(current!==generation.current)return;
     if(!Array.isArray(found.streams))throw new Error('ga4_invalid_response');
     setStreams(found.streams);setStreamsFor(chosen);
     setStreamId(found.streams.some(s=>s.id===c.property?.streamId)?c.property.streamId:found.streams.length===1?found.streams[0].id:'');
    }
   }
   if(name==='ga4-select'){setEditing(false);setMatchingOpen(false);setNotice('تم حفظ إعدادات GA4. اضغط «مزامنة GA4» لتحديث الفترة المختارة.');}
   if(name==='ga4-sync')setNotice(c.reconciliation?.enabled?'اكتملت مزامنة GA4 والمطابقة مع أحدث سجلات أودير.':'اكتملت مزامنة تحليلات الموقع من GA4.');
  }catch(e){if(current===generation.current)setError(e.message);}
  finally{if(current===generation.current)setBusy('');}
 }
 function exportPage(){const blob=new Blob([ga4Csv(report.rows||[])],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`ga4-orders-${from}-page-${page}.csv`;a.click();URL.revokeObjectURL(url);}
 const c=report?.coverage||{},s=report?.summary||{},traffic=report?.traffic||{};
 const rate=s.transactions?100*s.matchedOrders/s.transactions:null;
 const matching=report?.reconciliation?.enabled!==false;
 const selectedSite=streams.find(site=>site.id===streamId);
 const retainedConnection=propertyId===config?.property?.id&&selectedSite?.hostname===config?.property?.hostname?config?.reconciliation?.connectionId:null;
 return <section className={styles.panel} aria-busy={Boolean(busy)} aria-labelledby="ga4-title">
  <header className={styles.sectionHead}><div><span className={styles.eyebrow}>ضمن إضافة Google Kit</span><h2 id="ga4-title">{settings?'ربط Google Analytics (GA4)':'تحليلات الموقع ونتائج التسجيل'}</h2><p>الزيارات والتفاعل من GA4، والتسجيلات والتحصيل من سجلات أودير عند تفعيل المطابقة.</p></div><span className={`${styles.badge} ${config?.configured&&config?.consentGranted&&connected?styles.connected:styles.pending}`}>{config?.configured?(config?.consentGranted&&connected?'GA4 متصل':'يحتاج إعادة ربط'):'موصل GA4'}</span></header>
  {error?<p className={`${styles.feedback} ${styles.error}`} role="alert">{googleErrorMessage(error)}</p>:null}{notice?<p className={styles.feedback} role="status">{notice}</p>:null}
  {settings&&canManage?<div className={styles.actions}>
   {!config?.consentGranted||error==='ga4_consent_required'?<button className={styles.primary} disabled={Boolean(busy)} onClick={()=>action('start',{includeAnalytics:true})}>ربط GA4 مع جوجل</button>:<button className={styles.secondary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-assets')}>{config?.configured?'تغيير موقع القياس':'اختيار خاصية GA4'}</button>}
   {config?.configured?<><button className={styles.primary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-sync',{dateFrom:from,dateTo:to})}>{busy==='ga4-sync'?'جارٍ جلب البيانات…':'مزامنة GA4'}</button><button className={styles.textButton} disabled={Boolean(busy)} onClick={()=>action('ga4-disable')}>إيقاف موصل GA4</button></>:null}
  </div>:null}
  {!config?.configured?<p className={styles.note}>اختر خاصية GA4 وموقع المنشأة لبدء التحليل. يعمل مع سلة وزد والمواقع الخاصة ومواقع أودير عند تجهيز GA4 عليها؛ ربط متجر ليس شرطًا.</p>:<p className={styles.note}>{config.property?.name} · <span dir="ltr">{config.property?.hostname}</span> · توقيت القياس: <span dir="ltr">{config.property?.timezone}</span></p>}
  {settings&&editing&&canManage?<form className={styles.ga4Setup} onSubmit={e=>{e.preventDefault();action('ga4-select',{propertyId,streamId,connectionId:retainedConnection||null});}}>
   <div className={styles.reviewFields}>
    <label>خاصية GA4<select required disabled={Boolean(busy)} value={propertyId} onChange={e=>{const value=e.target.value;setPropertyId(value);setStreams([]);setStreamsFor('');setStreamId('');if(value)action('ga4-streams',{propertyId:value});}}><option value="">اختر الخاصية</option>{(config?.properties||[]).map(p=><option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label>
    <label>الموقع المراد تحليله<select required disabled={Boolean(busy)||streamsFor!==propertyId} value={streamId} onChange={e=>setStreamId(e.target.value)}><option value="">اختر موقع المنشأة</option>{streams.map(site=><option key={site.id} value={site.id}>{site.name} · {site.hostname}</option>)}</select></label>
   </div>
   <p className={styles.note}>تحليلات GA4 ضمن اشتراك Google Kit. اختر مسار بيانات الويب المخصص لموقع هذه المنشأة. بعد الحفظ يمكنك إضافة مصدر الطلبات بشكل اختياري.</p>
   {propertyId&&streamsFor===propertyId&&!streams.length?<p role="status" className={styles.note}>لا يوجد مسار بيانات ويب لهذه الخاصية. أضف موقعك في GA4 ثم أعد تحميل المواقع.</p>:null}
   <div className={styles.actions}>
    <button className={styles.primary} disabled={Boolean(busy)||!propertyId||!streamId||streamsFor!==propertyId}>حفظ ربط التحليلات</button>
    {propertyId?<button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>action('ga4-streams',{propertyId})}>إعادة تحميل المواقع</button>:null}
    <button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={()=>setEditing(false)}>إلغاء</button>
   </div>
  </form>:null}
  {settings&&config?.configured?<section className={styles.ga4Optional} aria-labelledby="ga4-matching-title">
   <div className={styles.sectionHead}><div><span className={styles.eyebrow}>خطوة اختيارية</span><h3 id="ga4-matching-title">مطابقة الطلبات والمدفوعات</h3><p>{config.reconciliation?.enabled?'المطابقة مفعّلة مع مصدر الطلبات المختار.':'تم حفظ ربط الموقع. استخدم «مزامنة GA4» لجلب التحليلات، ويمكنك إضافة مصدر الطلبات للتحقق من التسجيلات والتحصيل.'}</p></div><span className={`${styles.badge} ${config.reconciliation?.enabled?styles.connected:styles.pending}`}>{config.reconciliation?.enabled?'المطابقة مفعّلة':'بدون مطابقة مالية'}</span></div>
   {canManage&&config.stores?.length?<button type="button" className={styles.secondary} disabled={Boolean(busy)||!connected||editing} onClick={()=>{setConnectionId(config.reconciliation?.connectionId||'');setMatchingOpen(v=>!v);}}>إعداد مصدر الطلبات</button>:null}
   {!config.stores?.length?<p className={styles.note}>لا يوجد مصدر طلبات متصل بالمنشأة. يمكنك الاستمرار في التحليلات؛ موصل المطابقة المتاح حاليًا هو WooCommerce. قراءة GA4 لا تعني تفعيل استيراد طلبات سلة أو زد أو المواقع الأخرى.</p>:null}
   {matchingOpen&&canManage?<form className={styles.ga4Setup} onSubmit={e=>{e.preventDefault();action('ga4-select',{propertyId:config.property.id,streamId:config.property.streamId||null,connectionId:connectionId||null});}}>
    <div className={styles.reviewFields}><label>مصدر الطلبات<select disabled={Boolean(busy)} value={connectionId} onChange={e=>setConnectionId(e.target.value)}><option value="">بدون مطابقة مالية — تحليلات الموقع فقط</option>{(config.stores||[]).map(source=><option key={source.id} value={source.id}>WooCommerce · {source.url}</option>)}</select></label></div>
    {!connectionId&&!config.property.streamId?<p className={styles.note}>لفصل المطابقة مع استمرار التحليلات، اختر موقع القياس من إعداد GA4 أولًا.</p>:null}
    <p className={styles.note}>يجب أن يكون مصدر الطلبات للموقع نفسه. بعد تغيير المصدر، أعد المزامنة؛ تبقى الطلبات والمدفوعات الأصلية محفوظة.</p>
    <div className={styles.actions}><button className={styles.primary} disabled={Boolean(busy)||(!connectionId&&!config.property.streamId)}>حفظ مصدر المطابقة</button><button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={()=>setMatchingOpen(false)}>إلغاء</button></div>
   </form>:null}
  </section>:null}
  {!settings&&config?.configured&&canManage?<button type="button" className={styles.secondary} disabled={Boolean(busy)||!connected} onClick={()=>action('ga4-sync',{dateFrom:from,dateTo:to})}>{busy==='ga4-sync'?'جارٍ المزامنة…':'مزامنة GA4 السريعة'}</button>:null}
  {!settings&&!config?.configured&&busy!=='load'?<Link className={styles.secondary} href={`/tenant/${encodeURIComponent(slug)}/addons/google-kit`}>إعداد Google Analytics</Link>:null}
  {!settings&&report?.configured?<>
   <p className={styles.note}>قياسات GA4 للموقع والفترة المختارين. الجلسات وأحداث الشراء ليست عدد الطلاب المسجلين أو إثباتًا للتحصيل.</p>
   <p className={styles.note}>{c.complete?'اكتملت قراءة الفترة':'أيام غير متزامنة: '+number(c.missingDays)} · آخر مزامنة: {c.latestSync?new Date(c.latestSync).toLocaleString('ar-EG'):'لم تتم بعد'}{c.transactionDataLimited||c.trafficDataLimited?' · Google أعاد بيانات محدودة':''}</p>
   <div className={styles.metrics}>
    <Metric label="جلسات الموقع" value={number(traffic.sessions)} note="قياس GA4 ضمن الموقع المختار"/>
    <Metric label="جلسات متفاعلة" value={number(traffic.engagedSessions)} note={traffic.sessions?`${formatGoogleMetric(100*traffic.engagedSessions/traffic.sessions,{digits:1})}% من الجلسات`:undefined}/>
    <Metric label="مشاهدات الصفحات" value={number(traffic.pageViews)} note="عدد المشاهدات؛ قد يزور الشخص أكثر من صفحة"/>
    <Metric label="أحداث الشراء في GA4" value={number(traffic.purchases)} note="قياس الموقع؛ لا يثبت استلام المبلغ"/>
   </div>
   {!matching?<div className={styles.ga4Optional}><b>التسجيلات والتحصيل المؤكد</b><p className={styles.note}>غير متاح في هذا التقرير حتى تفعيل مطابقة الطلبات مع سجلات أودير. يمكنك استخدام تحليلات الموقع ومصادر الزيارات بشكل مستقل.</p>{canManage?<Link className={styles.secondary} href={`/tenant/${encodeURIComponent(slug)}/addons/google-kit`}>إعداد المطابقة الاختيارية</Link>:null}</div>:<>
   <div className={styles.ga4Subhead}><h3>النتائج المؤكدة في أودير</h3><span className={styles.badge}>مطابقة الطلبات والمدفوعات</span></div>
   <p className={styles.note}>الطلبات بحسب تاريخ الشراء في GA4، والتحصيل حتى {asOf}. قد تتقاطع مع المطابقة اليدوية في التقرير؛ لا تجمع المجموعتين.</p>
   <div className={styles.metrics}>
    <Metric label="طلبات مطابقة" value={number(s.matchedOrders)} note={rate!==null?`${formatGoogleMetric(rate,{digits:1})}% من معاملات GA4 المتاحة`:'لا توجد معاملات للمقارنة'}/>
    <Metric label="طلبات بدفع معتمد" value={number(s.verifiedOrders)} note="وفق سجلات التحصيل في أودير"/>
    <Metric label="تسجيلات بدفع معتمد" value={number(s.verifiedRegistrations)} note="قد يشمل الطلب أكثر من تسجيل"/>
    <Metric label="تحتاج مراجعة" value={number((s.unmatched||0)+(s.pendingPayments||0))} note="مطابقة ناقصة أو دفع لم يُعتمد"/>
   </div>
   {report.canReadMoney?(report.finances||[]).map(f=><div className={styles.metrics} key={f.currency}><Metric label={`التحصيل المعتمد · ${f.currency}`} value={money(f.collectionsMinor,f.currency)}/><Metric label="استردادات مكتملة" value={money(f.refundsMinor,f.currency)}/><Metric label="صافي التحصيل المطابق" value={money(f.netMinor,f.currency)} note="أقساط وتحويلات مثبتة مرة واحدة"/></div>):null}
   </>}
   <div className={styles.reviewPreview}><b>ما الذي يحتاج اهتمامك؟</b><ul>{ga4Insights(report).map(text=><li key={text}>{text}</li>)}</ul></div>
   <details className={styles.details}><summary>مصادر الزيارات والتفاعل</summary>
    {report.trafficSources?.length?<div className={styles.tableWrap}><table className={`${styles.table} ${styles.ga4Sources}`}><caption>{report.trafficSourceCount>20?'أعلى ٢٠ مصدرًا بحسب الجلسات؛ بطاقات الملخص تشمل جميع المصادر.':'المصادر بحسب جلسات GA4؛ تتأثر النتائج بقيود القياس الموضحة أعلاه.'}</caption><thead><tr><th>المصدر / الوسيط</th><th>الجلسات</th><th>نسبة التفاعل</th><th>مشاهدات الصفحات</th><th>أحداث الشراء</th></tr></thead><tbody>{report.trafficSources.map(row=><tr key={JSON.stringify([row.source,row.medium])}><th><b dir="auto">{row.source||'غير محدد'} / {row.medium||'غير محدد'}</b></th><td data-label="الجلسات">{number(row.sessions)}</td><td data-label="نسبة التفاعل">{row.sessions?formatGoogleMetric(100*row.engagedSessions/row.sessions,{digits:1})+'%':'غير متاح'}</td><td data-label="مشاهدات الصفحات">{number(row.pageViews)}</td><td data-label="أحداث الشراء">{number(row.purchases)}</td></tr>)}</tbody></table></div>:<p className={styles.note}>{c.complete?'لا توجد زيارات مسجلة في الفترة المختارة.':'تظهر المصادر بعد مزامنة بيانات الموقع.'}</p>}
    <div className={styles.metrics}><Metric label="إضافة للسلة" value={number(traffic.addToCarts)} note="أحداث مسجلة في GA4 إذا كان الموقع يرسلها"/><Metric label="بدء الدفع" value={number(traffic.checkouts)} note="أحداث مسجلة في GA4 إذا كان الموقع يرسلها"/><Metric label="معاملات الشراء" value={number(s.transactions)} note="معرّفات معاملات GA4 المتاحة"/></div>
   </details>
   {matching?<details className={styles.details}><summary>الحملات ومعاملات المتجر ودليل المطابقة</summary>
   {report.campaigns?.length?<div className={styles.tableWrap}><table className={styles.table}><caption>نتائج الطلبات حسب حملة جلسة الشراء؛ لا تمثل تكلفة اكتساب طالب جديد.</caption><thead><tr><th>الحملة</th><th>طلبات</th><th>دفع معتمد</th><th>تسجيلات معتمدة الدفع</th><th>صافي التحصيل</th></tr></thead><tbody>{report.campaigns.map(row=><tr key={row.id}><th><button className={styles.textButton} onClick={()=>{setCampaignId(row.id);setPage(1);}}>{row.name||row.id}</button></th><td data-label="الطلبات">{number(row.orders)}</td><td data-label="دفع معتمد">{number(row.verifiedOrders)}</td><td data-label="التسجيلات">{number(row.verifiedRegistrations)}</td><td data-label="صافي التحصيل">{row.finances?.length?row.finances.map(f=><div key={f.currency}>{money(f.netMinor,f.currency)}</div>):'غير متاح'}</td></tr>)}</tbody></table></div>:null}
   <div className={styles.actions}><label>حالة المطابقة <select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="all">كل الحالات</option><option value="verified">دفع معتمد</option><option value="payment_pending">ينتظر الدفع</option><option value="unmatched">تحتاج مطابقة</option></select></label>{campaignId?<button className={styles.secondary} onClick={()=>{setCampaignId('');setPage(1);}}>كل الحملات</button>:null}{report.canReadDetails&&report.rows?.length?<button className={styles.secondary} onClick={exportPage}>تصدير الصفحة CSV</button>:null}</div>
   {report.canReadDetails?<><div className={styles.tableWrap}><table className={styles.table}><caption>دليل المطابقة لكل معاملة — حتى ٥٠ صفًا في الصفحة</caption><thead><tr><th>المعاملة / الطلب</th><th>المصدر والحملة</th><th>المطابقة</th><th>التسجيلات</th>{report.canReadMoney?<><th>صافي التحصيل</th><th>مراجعة القيمة</th></>:null}</tr></thead><tbody>{(report.rows||[]).map(row=><tr key={row.transactionId}><th><span dir="ltr">{row.transactionId}</span><small>{row.date} · طلب {row.orderNumber||'—'}</small></th><td data-label="المصدر والحملة">{row.source} / {row.medium}<small>{row.campaignName}</small></td><td data-label="المطابقة">{ga4StatusLabels[row.status]||row.status}</td><td data-label="التسجيلات">{number(row.verifiedRegistrations)}</td>{report.canReadMoney?<><td data-label="صافي التحصيل">{money(row.netMinor,row.currency)}</td><td data-label="مراجعة القيمة">{ga4AmountLabels[row.amountCheck]||'—'}</td></>:null}</tr>)}</tbody></table></div><nav className={styles.pagination} aria-label="صفحات معاملات GA4"><button className={styles.secondary} disabled={page===1||Boolean(busy)} onClick={()=>setPage(p=>p-1)}>السابق</button><span>{number(page)} · {number(report.totalRows)} معاملة</span><button className={styles.secondary} disabled={!report.hasMore||Boolean(busy)} onClick={()=>setPage(p=>p+1)}>التالي</button></nav></>:<p className={styles.note}>تفاصيل الطلبات متاحة لمن لديه صلاحية قراءة العملاء.</p>}
   </details>:null}
  </>:busy==='load'?<p className={styles.note}>جارٍ تحميل حالة التتبع…</p>:null}
 </section>;
}
