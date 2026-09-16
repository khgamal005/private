'use client';

import Link from 'next/link';
import Image from 'next/image';
import {useRouter} from 'next/navigation';
import {useEffect,useState} from 'react';
import {
  formatGoogleMetric,googleCampaignEconomics,googleErrorMessage,googleReportFilters,
  googleReportHref,googleSourcePreview,groupGoogleSources,requestGoogleAction
} from '../lib/google-ads/ui.mjs';
import styles from './google-ads-connect.module.css';
import GoogleGA4Report from './google-ga4-report';
import CampaignReportPlatformNav from './campaign-report-platform-nav';

const formatDate=(value,timezone)=>{
  if(!value)return 'لم تتم المزامنة بعد';
  try{return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short',timeZone:timezone||'Asia/Riyadh'}).format(new Date(value));}
  catch{return 'غير متاح';}
};

function Feedback({feedback}){
  if(!feedback)return null;
  return <p className={`${styles.feedback} ${feedback.error?styles.error:styles.success}`}
    role={feedback.error?'alert':'status'}>{feedback.message}</p>;
}

function Metric({label,value,note,accent=false}){
  return <article className={`${styles.metric} ${accent?styles.metricAccent:''}`}>
    <span>{label}</span><strong>{value}</strong>{note?<small>{note}</small>:null}
  </article>;
}

function SourceReview({slug,canManage,initialCampaigns,onSaved}){
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState('');
  const [feedback,setFeedback]=useState(null);
  const [data,setData]=useState(null);
  const [selectedKeys,setSelectedKeys]=useState([]);
  const [campaignId,setCampaignId]=useState('');
  const [reason,setReason]=useState('مطابقة مصدر ملف العملاء مع الحملة بعد مراجعة المجموعة');
  const [preview,setPreview]=useState(null);
  const groups=groupGoogleSources(data?.rows||[]);
  const targets=data?.campaigns||initialCampaigns||[];

  async function load(offset=0){
    if(!canManage||busy)return;
    setOpen(true);setBusy('load');setFeedback(null);setPreview(null);setSelectedKeys([]);
    try{setData(await requestGoogleAction({name:'sources',slug,payload:{offset}}));}
    catch(error){setFeedback({error:true,message:googleErrorMessage(error.message)});}
    finally{setBusy('');}
  }

  function chooseGroup(key,checked){
    setSelectedKeys(current=>checked?[...current,key]:current.filter(value=>value!==key));
    setPreview(null);
  }

  async function confirm(){
    if(!preview||busy)return;
    setBusy('save');setFeedback(null);
    try{
      await requestGoogleAction({name:'review',slug,payload:{
        campaignId:preview.campaignId,commandId:crypto.randomUUID(),rows:preview.rows,reason:reason.trim()
      }});
      setPreview(null);setSelectedKeys([]);setData(null);
      setFeedback({message:'تم حفظ المطابقة اليدوية للمجموعة. حدّث المصادر لمراجعة مجموعة أخرى.'});
      onSaved();
    }catch(error){setPreview(null);setFeedback({error:true,message:googleErrorMessage(error.message)});}
    finally{setBusy('');}
  }

  return <section className={styles.panel} aria-busy={Boolean(busy)}>
    <header className={styles.sectionHead}>
      <div><span className={styles.eyebrow}>مصادر العملاء في أودير</span><h2>راجع المصدر مرة واحدة للمجموعة</h2>
        <p>اجمع الصفوف التي تحمل نفس المصدر واسم الحملة، ثم طابقها مع حملة جوجل. يظهر هذا الربط في التقرير باعتباره ربطًا يدويًا.</p></div>
      <button type="button" className={styles.secondary} disabled={!canManage||Boolean(busy)} onClick={()=>open?setOpen(false):load()}>
        {busy==='load'?'جارٍ تحميل المصادر…':open?'إغلاق المراجعة':'مراجعة مصادر الملفات'}
      </button>
    </header>
    {!canManage?<p className={styles.note}>يتولى مدير المنشأة أو الموظف المخوّل مراجعة ربط المصادر.</p>:null}
    {open?<div className={styles.reviewBody}>
      <Feedback feedback={feedback}/>
      {data?<>
        <p className={styles.note}>المعاينة تخص الصفوف الظاهرة في هذه الدفعة فقط. {data.totalRows!=null?`إجمالي الصفوف المتاحة: ${formatGoogleMetric(data.totalRows)}.`:''}</p>
        {groups.length?<div className={styles.sourceList}>{groups.map(group=><label className={styles.sourceRow} key={group.key}>
          <input type="checkbox" checked={selectedKeys.includes(group.key)} disabled={Boolean(busy)} onChange={event=>chooseGroup(group.key,event.target.checked)}/>
          <span><b>{group.campaignName}</b><small>{group.source}{group.campaignId?' · مرتبط بحملة حاليًا':''}</small></span>
          <strong>{formatGoogleMetric(group.rows.length)} <small>صفًا</small></strong>
        </label>)}</div>:<p className={styles.empty}>لا توجد مصادر قابلة للمراجعة في هذه الدفعة.</p>}
        <div className={styles.reviewFields}>
          <label>الحملة التي تخص هذه المصادر<select value={campaignId} disabled={Boolean(busy)} onChange={event=>{setCampaignId(event.target.value);setPreview(null);}}>
            <option value="">اختر الحملة</option>{targets.map(campaign=><option key={campaign.campaignId} value={campaign.campaignId}>{campaign.name} · {campaign.campaignId}</option>)}
          </select></label>
          <label>سبب المطابقة<input value={reason} minLength={5} maxLength={300} placeholder="٥ أحرف على الأقل" disabled={Boolean(busy)} onChange={event=>{setReason(event.target.value);setPreview(null);}}/></label>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={!selectedKeys.length||!campaignId||reason.trim().length<5||Boolean(busy)} onClick={()=>setPreview(googleSourcePreview(groups,selectedKeys,campaignId,targets))}>معاينة المطابقة</button>
          <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>load(data.offset||0)}>تحديث المصادر</button>
        </div>
        {preview?<div className={styles.reviewPreview} role="region" aria-label="معاينة المطابقة اليدوية">
          <b>سيُربط {formatGoogleMetric(preview.rowCount)} صفًا بحملة «{preview.campaignName}»</b>
          <p>من {formatGoogleMetric(preview.groupCount)} مجموعة ظاهرة. ستُسجل المطابقة كدليل يدوي مع اسم المراجع؛ راجع اختيارك قبل الحفظ.</p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={confirm}>{busy==='save'?'جارٍ الحفظ…':'تأكيد وحفظ المطابقة'}</button>
            <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>setPreview(null)}>العودة للمراجعة</button>
          </div>
        </div>:null}
        <nav className={styles.pagination} aria-label="دفعات مصادر العملاء">
          <button type="button" className={styles.secondary} disabled={Boolean(busy)||!(data.offset>0)} onClick={()=>load(Math.max(0,data.offset-200))}>الدفعة السابقة</button>
          <button type="button" className={styles.secondary} disabled={Boolean(busy)||data.hasMore!==true} onClick={()=>load((data.offset||0)+200)}>الدفعة التالية</button>
        </nav>
      </>:busy==='load'?<p className={styles.empty}>جارٍ تجهيز مجموعات المصادر…</p>:<button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>load()}>تحميل المصادر</button>}
    </div>:null}
  </section>;
}

export default function GoogleAdsConnect({slug,initialData,initialReport,filters,outcome,reason,unavailable=false}){
  const router=useRouter();
  const data=initialData||{};
  const report=initialReport||{};
  const selected=data.selectedAccount;
  const enabled=Boolean(data.addonEnabled&&data.enabled!==false&&!['reefskills'].includes(slug.toLowerCase()));
  const canManage=Boolean(enabled&&data.canManage);
  const reportingOnly=slug==='reef-skills';
  const [accounts,setAccounts]=useState(()=>data.accounts||null);
  const [busy,setBusy]=useState('');
  const [feedback,setFeedback]=useState(()=>outcome==='connected'
    ?{message:'تم ربط جوجل. اختر حساب الإعلانات لتبدأ المزامنة تلقائيًا.'}
    :outcome==='error'?{error:true,message:googleErrorMessage(reason)}
      :outcome==='cancelled'?{message:'أُلغيت محاولة الربط. يمكنك المحاولة مرة أخرى.'}:null);
  const [detailsCampaign,setDetailsCampaign]=useState(null);
  const [showAccounts,setShowAccounts]=useState(false);
  const [confirmDisconnect,setConfirmDisconnect]=useState(false);
  const connected=data.status==='connected';
  const summary=report.summary||{};
  const campaigns=report.campaigns||[];
  const range=report.range||{from:filters.dateFrom,to:filters.dateTo,asOf:filters.asOf};
  const currency=report.currency||selected?.currency||'';
  const metric=(value,options={})=>formatGoogleMetric(value,{currency,...options});

  useEffect(()=>{
    if(!canManage||!connected||selected||data.accounts?.length)return;
    const controller=new AbortController();
    requestGoogleAction({name:'assets',slug,signal:controller.signal})
      .then(result=>setAccounts(result.accounts||[]))
      .catch(error=>{if(error.name!=='AbortError')setFeedback({error:true,message:googleErrorMessage(error.message)});});
    return ()=>controller.abort();
  },[canManage,connected,selected,data.accounts?.length,slug]);

  async function action(name,payload={}){
    if(!canManage||busy)return;
    setBusy(name);setFeedback(null);
    let savedSelection=false;
    try{
      if(name==='start'){
        const analytics=await requestGoogleAction({name:'ga4-status',slug});
        payload={...payload,includeAnalytics:analytics.consentGranted===true};
      }
      const result=await requestGoogleAction({name,slug,payload});
      if(name==='start'){window.location.assign(result.authorizeUrl);return;}
      if(name==='assets'){setAccounts(result.accounts||[]);return;}
      if(name==='select'){
        savedSelection=true;setShowAccounts(false);setBusy('sync');
        const chosen=accounts?.find(account=>account.customerId===payload.accountId);
        const initialRange=googleReportFilters({from:filters.dateFrom,to:filters.dateTo,asOf:filters.asOf},new Date(),data.tenantTimezone||'Asia/Riyadh',chosen?.timezone||'Asia/Riyadh');
        const synced=await requestGoogleAction({name:'sync',slug,payload:{dateFrom:initialRange.dateFrom,dateTo:initialRange.dateTo}});
        if(synced.status==='failed')throw new Error('sync_failed');
        setFeedback({message:['queued','running'].includes(synced.status)?'تم حفظ الحساب والمزامنة جارية. حدّث التقرير بعد قليل.':'تم اختيار الحساب ومزامنة الفترة. يعرض التقرير البيانات المتاحة.'});
      }else if(name==='disconnect'){
        setAccounts(null);setConfirmDisconnect(false);setFeedback({message:'تم فصل الربط. يمكنك إعادة توصيل حساب جوجل عند الحاجة.'});
      }else{
        if(result.status==='failed')throw new Error('sync_failed');
        setFeedback({message:['queued','running'].includes(result.status)?'المزامنة جارية. حدّث التقرير بعد قليل.':'اكتملت المزامنة. يعرض التقرير البيانات المتاحة للفترة.'});
      }
      router.refresh();
    }catch(error){
      setFeedback({error:true,message:savedSelection?'تم حفظ الحساب، لكن المزامنة الأولى لم تكتمل. اضغط «مزامنة الفترة» للمحاولة مجددًا.':googleErrorMessage(error.message)});
      if(savedSelection)router.refresh();
    }finally{setBusy('');}
  }

  function applyFilters(event){
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const next=googleReportFilters(values,new Date(),data.tenantTimezone||'Asia/Riyadh',selected?.timezone);
    if(next.rangeLimited){setFeedback({error:true,message:'اختر فترة لا تتجاوز ٣١ يومًا لعرض البيانات ومزامنتها.'});return;}
    router.push(googleReportHref(slug,next,{page:1}));
  }

  return <section className={styles.page} dir="rtl">
    <header className={styles.hero}>
      <div className={styles.heroTitle}><span className={styles.provider}><Image src="/integrations/google-ads-color.svg" alt="" width={36} height={36}/></span>
        <div><span className={styles.eyebrow}>تقارير التسويق</span><h1 dir="ltr">Google Kit</h1><p>إعلانات جوجل وGA4 ومطابقة الطلبات بالتحصيل الفعلي داخل أودير.</p></div>
      </div>
      <Link className={styles.heroLink} href={`/tenant/${encodeURIComponent(slug)}/reports`}>كل التقارير <span aria-hidden="true">←</span></Link>
    </header>
    <CampaignReportPlatformNav slug={slug} active="google" from={filters.dateFrom} to={filters.dateTo}/>
    <Feedback feedback={feedback}/>
    {enabled&&reportingOnly?<p className={styles.note}>تجربة ريف: قراءة تقارير جوجل فقط، دون تعديل الحملات أو العملاء أو التسجيلات أو المدفوعات. مطابقة مصادر العملاء متوقفة في هذه المرحلة.</p>:null}
    {unavailable?<p className={`${styles.feedback} ${styles.error}`} role="alert">تعذر تحميل التقرير حاليًا. حاول تحديث الصفحة بعد قليل.</p>:null}
    {!enabled?unavailable?null:<section className={styles.panel}><h2>الربط غير متاح حاليًا</h2><p>تواصل مع إدارة المنصة لتفعيل إضافة Google Kit لهذه المنشأة.</p></section>:<>
      <section className={styles.connection} aria-busy={Boolean(busy)}>
        <div className={styles.connectionMain}>
          <header className={styles.sectionHead}><div><span className={styles.eyebrow}>حساب الإعلانات</span><h2>{selected?.name||'اربط جوجل وابدأ التحليل'}</h2></div>
            <span className={`${styles.badge} ${connected?styles.connected:styles.pending}`}>{connected?'متصل':data.status==='reauth_required'?'يحتاج إعادة ربط':'غير متصل'}</span></header>
          <p>قراءة الحملات والإنفاق والنتائج داخل أودير.</p>
          <dl className={styles.accountDetails}>
            <div><dt>الحساب المختار</dt><dd dir="ltr">{selected?.customerId||'لم يُحدد بعد'}</dd></div>
            <div><dt>آخر مزامنة</dt><dd>{formatDate(data.sync?.lastSyncedAt,selected?.timezone)}</dd></div>
            {selected?.timezone?<div><dt>توقيت الحساب</dt><dd dir="ltr">{selected.timezone}</dd></div>:null}
          </dl>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={!canManage||Boolean(busy)} onClick={()=>action('start')}>{busy==='start'?'جارٍ فتح جوجل…':connected?'إعادة ربط جوجل':'ربط حساب جوجل'}</button>
            {selected?<button type="button" className={styles.secondary} disabled={!canManage||!connected||Boolean(busy)} onClick={()=>action('sync',{dateFrom:filters.dateFrom,dateTo:filters.dateTo})}>{busy==='sync'?'جارٍ المزامنة…':'مزامنة الفترة'}</button>:null}
            {selected&&connected&&canManage?<button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>{setShowAccounts(true);action('assets');}}>تغيير الحساب</button>:null}
            {connected&&canManage?<button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={()=>setConfirmDisconnect(true)}>فصل الربط</button>:null}
          </div>
          {!canManage?<p className={styles.note}>يمكنك متابعة التقارير. إدارة الربط متاحة لمدير المنشأة والموظف المخوّل.</p>:null}
          {confirmDisconnect?<div className={styles.reviewPreview}><b>هل تريد فصل حساب جوجل؟</b><p>ستتوقف المزامنة حتى تعيد الربط.</p><div className={styles.actions}>
            <button type="button" className={styles.danger} disabled={Boolean(busy)} onClick={()=>action('disconnect')}>تأكيد فصل الربط</button>
            <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>setConfirmDisconnect(false)}>إلغاء</button>
          </div></div>:null}
        </div>
        <ol className={styles.steps}>
          <li className={connected?styles.stepDone:''}><span>١</span><div><b>ربط جوجل</b><small>موافقة آمنة من حسابك</small></div></li>
          <li className={selected?styles.stepDone:''}><span>٢</span><div><b>اختيار حساب الإعلانات</b><small>حساب واحد لهذه المنشأة</small></div></li>
          <li className={data.sync?.lastSyncedAt?styles.stepDone:''}><span>٣</span><div><b>ظهور الحملات والنتائج</b><small>تبدأ المزامنة بعد الاختيار</small></div></li>
        </ol>
      </section>

      {connected&&canManage&&(!selected||showAccounts)?<section className={styles.panel}>
        <header className={styles.sectionHead}><div><h2>اختر حساب الإعلانات</h2><p>تبدأ المزامنة الأولى بعد اختيار الحساب مباشرة.</p></div>
          <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={()=>action('assets')}>تحديث الحسابات</button></header>
        {accounts===null?<p className={styles.empty}>جارٍ البحث عن حساباتك المتاحة…</p>:accounts.length?<div className={styles.accounts}>{accounts.map(account=><article key={account.customerId}>
          <div><b>{account.name||account.customerId}</b><small dir="ltr">{account.customerId} · {account.currency||'—'}</small></div>
          <button type="button" className={styles.primary} disabled={Boolean(busy)||account.customerId===selected?.customerId} onClick={()=>action('select',{accountId:account.customerId})}>{account.customerId===selected?.customerId?'الحساب الحالي':busy?'جارٍ التجهيز…':'اختيار الحساب'}</button>
        </article>)}</div>:<p className={styles.empty}>لم تظهر حسابات إعلانية متاحة. تأكد من وصول حساب جوجل إلى الحساب المطلوب، ثم حدّث القائمة.</p>}
      </section>:null}

      <section className={styles.panel}>
        <form className={styles.filters} onSubmit={applyFilters} key={`${filters.dateFrom}:${filters.dateTo}:${filters.asOf}:${filters.search}`}>
          <label>من<input type="date" name="from" required max={filters.syncToday||filters.today} defaultValue={filters.dateFrom}/></label>
          <label>إلى<input type="date" name="to" required max={filters.syncToday||filters.today} defaultValue={filters.dateTo}/></label>
          <label>متابعة النتائج حتى<input type="date" name="asOf" required min={filters.dateTo} max={filters.today} defaultValue={filters.asOf}/></label>
          <label className={styles.search}>ابحث عن حملة<input type="search" name="q" maxLength={80} placeholder="اسم الحملة أو رقمها" defaultValue={filters.search}/></label>
          <button type="submit" className={styles.primary}>عرض التقرير</button>
        </form>
        <p className={styles.note}>الفترة تخص إنفاق الحملات والعملاء الذين وصلوا خلالها. تُتابع نتائجهم حتى {range.asOf||filters.asOf} وفق البيانات المتاحة.</p>
        {filters.rangeLimited?<p className={`${styles.feedback} ${styles.error}`} role="status">تم تحديد الفترة بآخر ٣١ يومًا من تاريخ النهاية. اختر فترة أقصر لعرض شهر آخر.</p>:null}
      </section>

      {selected?<>
        <section aria-labelledby="google-performance-title">
          <header className={styles.sectionHead}><div><span className={styles.eyebrow}>بيانات حساب الإعلانات</span><h2 id="google-performance-title">الأداء في جوجل</h2></div><span className={styles.badge}>المصدر: Google Ads</span></header>
          <div className={styles.metrics}>
            <Metric label="الإنفاق الإعلاني" value={metric(summary.spendMinor,{money:true})} note={report.coverage?.spendComplete?'مزامنة مكتملة للفترة':'قد تكون بيانات الفترة غير مكتملة'} accent/>
            <Metric label="النقرات" value={metric(summary.clicks)}/>
            <Metric label="النتائج المسجلة لدى جوجل" value={metric(summary.googleConversions,{digits:2})} note="بحسب إعداد التحويلات في حساب جوجل"/>
            <Metric label="الحملات في التقرير" value={metric(report.totalCampaigns)} note={filters.search?'وفق البحث الحالي':undefined}/>
          </div>
        </section>
        <section aria-labelledby="google-odeir-title">
          <header className={styles.sectionHead}><div><span className={styles.eyebrow}>المصدر: سجلات أودير</span><h2 id="google-odeir-title">من العملاء إلى التسجيل والتحصيل</h2></div><span className={`${styles.badge} ${styles.manual}`}>مطابقة مصادر يدوية</span></header>
          <div className={styles.metrics}>
            <Metric label="العملاء المرتبطون يدويًا" value={metric(summary.manualLeads)} note="بحسب المصادر التي تمت مراجعتها"/>
            <Metric label="تسجيلات بدفع مؤكد" value={metric(summary.registrations)} note="قد يكون للعميل أكثر من تسجيل"/>
            <Metric label="عملاء بدفع مؤكد" value={metric(summary.verifiedPayers)} note="بعد اعتماد الدفع في أودير"/>
            <Metric label="صافي التحصيل" value={metric(summary.netCollectionsMinor,{money:true})} note="وفق المبالغ المسجلة والاستردادات" accent/>
          </div>
          <p className={styles.note}>نتائج جوجل ونتائج أودير مقياسان منفصلان. ربط المصدر هنا يدوي بعد مراجعة ملفات العملاء؛ لا يمثل تتبعًا تلقائيًا لزيارات المتجر.</p>
        </section>
        <section className={styles.panel}>
          <header className={styles.sectionHead}><div><h2>ماذا حققت كل حملة؟</h2><p>تكلفة العميل الدافع والعائد يُحسبان عند اكتمال الإنفاق وتوافق الفترة والعملة.</p></div></header>
          {campaigns.length?<div className={styles.tableWrap}><table className={styles.table}>
            <caption>النتائج المالية مبنية على مطابقة المصادر اليدوية. العائد هو صافي التحصيل ÷ الإنفاق، وليس صافي الربح.</caption>
            <thead><tr><th scope="col">الحملة</th><th scope="col">الإنفاق</th><th scope="col">النقرات</th><th scope="col">نتائج جوجل</th><th scope="col">عملاء أودير</th><th scope="col">دفع مؤكد</th><th scope="col">صافي التحصيل</th><th scope="col">تكلفة الدافع</th><th scope="col">العائد</th></tr></thead>
            <tbody>{campaigns.map(campaign=>{
              const economics=googleCampaignEconomics(campaign,report.coverage);
              return <tr key={campaign.campaignId}>
                <th scope="row"><b>{campaign.name}</b><small dir="ltr">{campaign.campaignId}</small>{data.canReadDetails?<button className={styles.textButton} type="button" onClick={()=>setDetailsCampaign(campaign)}>عرض العملاء</button>:null}</th>
                <td data-label="الإنفاق">{metric(campaign.spendMinor,{money:true})}</td><td data-label="النقرات">{metric(campaign.clicks)}</td><td data-label="نتائج جوجل">{metric(campaign.googleConversions,{digits:2})}</td>
                <td data-label="عملاء أودير">{metric(campaign.manualLeads)}</td><td data-label="دفع مؤكد">{metric(campaign.verifiedPayers)}</td><td data-label="صافي التحصيل">{metric(campaign.netCollectionsMinor,{money:true})}</td>
                <td data-label="تكلفة الدافع" title={economics.reason}>{metric(economics.costPerPayerMinor,{money:true})}</td><td data-label="العائد" title={economics.reason}>{economics.collectionRoas===null?'غير متاح':`${metric(economics.collectionRoas,{digits:2})}×`}</td>
              </tr>;
            })}</tbody>
          </table></div>:<div className={styles.empty}><b>لا توجد حملات معروضة لهذه الفترة</b><p>راجع المزامنة أو غيّر الفترة والبحث. القيم غير المتاحة لا تُحسب كصفر.</p></div>}
          <nav className={styles.pagination} aria-label="صفحات الحملات">
            {filters.page>1?<Link className={styles.secondary} href={googleReportHref(slug,filters,{page:filters.page-1})}>السابق</Link>:<span/>}
            <span>الصفحة {metric(report.page||filters.page)}</span>
            {report.hasMore===true||(report.totalCampaigns||0)>filters.page*50?<Link className={styles.secondary} href={googleReportHref(slug,filters,{page:filters.page+1})}>التالي</Link>:<span/>}
          </nav>
        </section>
        {detailsCampaign&&data.canReadDetails?<section className={styles.panel} aria-label="عملاء الحملة">
          <header className={styles.sectionHead}><div><h2>عملاء «{detailsCampaign.name}»</h2><p>عينة من التفاصيل المتاحة في التقرير، بحد أقصى ٥٠ صفًا.</p></div><button className={styles.secondary} type="button" onClick={()=>setDetailsCampaign(null)}>إغلاق</button></header>
          <div className={styles.customerList}>{(report.details||[]).filter(row=>row.campaignId===detailsCampaign.campaignId).map(row=><div key={row.originKey}><b>{row.name||'عميل بدون اسم'}</b><span className={`${styles.badge} ${row.paid?styles.connected:styles.pending}`}>{row.paid?'دفع مؤكد':'لم يتأكد الدفع'}</span></div>)}</div>
          {!(report.details||[]).some(row=>row.campaignId===detailsCampaign.campaignId)?<p className={styles.empty}>لا تتوافر تفاصيل عملاء لهذه الحملة ضمن العينة الحالية.</p>:null}
        </section>:null}
        <GoogleGA4Report key={`${slug}:${filters.dateFrom}:${filters.dateTo}:${filters.asOf}`} slug={slug} filters={filters} canManage={canManage} connected={connected}/>
        {!reportingOnly?<SourceReview slug={slug} canManage={canManage} initialCampaigns={campaigns} onSaved={()=>router.refresh()}/>:null}
      </>:<section className={styles.empty}><b>يبدأ التقرير بعد اختيار حساب الإعلانات</b><p>اربط جوجل، ثم اختر الحساب لعرض الحملات المتاحة.</p></section>}
    </>}
  </section>;
}

