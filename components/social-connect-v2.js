'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect,useState} from 'react';
import {
  connectionNeedsReauthorization,runConnectionAction
} from '../lib/social-connect-v2.mjs';
import {socialReportHref} from '../lib/social-connect-report.mjs';

const STATUS={
  connected:{label:'متصل',tone:'ready'},
  reauth_required:{label:'يحتاج إعادة ربط',tone:'warning'},
  deauthorized:{label:'تم إلغاء التفويض',tone:'warning'},
  deletion_requested:{label:'حُذفت بيانات الربط',tone:'muted'},
  disabled:{label:'غير متصل',tone:'muted'},
  error:{label:'يحتاج مراجعة',tone:'error'}
};

const ERRORS={
  authentication_required:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مجددًا.',
  session_expired:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مجددًا.',
  forbidden:'ليست لديك صلاحية إدارة الربط. تواصل مع مدير المنشأة.',
  addon_not_enabled:'الإضافة غير مفعلة لهذه المنشأة.',
  meta_connect_v2_not_in_rollout:'الربط غير متاح لهذه المنشأة بعد. تواصل مع الدعم.',
  meta_connect_v2_oauth_disabled:'الربط غير متاح حاليًا. حاول لاحقًا.',
  meta_connect_v2_capability_disabled:'هذه الخطوة مغلقة مؤقتًا. حاول لاحقًا.',
  meta_connect_v2_reauthorization_required:'انتهت صلاحية الاتصال. أعد ربط حساب Meta.',
  legacy_meta_connection_present:'منشأتك لديها ربط قائم. يمكنك متابعته من مركز التسويق.',
  required_scopes_missing:'لم تُمنح صلاحية قراءة الإعلانات. أعد الربط ووافق على الصلاحية المطلوبة.',
  oauth_state_invalid:'انتهت محاولة الربط أو لم تعد صالحة. ابدأ محاولة جديدة.',
  oauth_state_invalid_or_used:'انتهت محاولة الربط أو استُخدمت بالفعل. ابدأ محاولة جديدة.',
  oauth_exchange_failed:'لم يكتمل الربط مع Meta. حاول مرة أخرى.',
  oauth_token_invalid:'تعذر التحقق من التفويض. أعد الربط من حساب Meta الصحيح.',
  excessive_scopes_granted:'إعداد الربط يمنح صلاحيات إضافية. تواصل مع الدعم لضبطه على قراءة الإعلانات فقط.',
  oauth_session_mismatch:'انتهت جلسة الربط أو تغيّر حساب الدخول. سجّل الدخول ثم ابدأ محاولة جديدة.',
  meta_connect_v2_account_invalid:'الحساب الإعلاني المختار غير صالح.',
  meta_connect_v2_account_not_available:'لم يعد الحساب الإعلاني متاحًا لهذا التفويض. أعد المحاولة.',
  meta_asset_discovery_failed:'تعذر تحميل الحسابات الإعلانية من Meta الآن. حاول مجددًا.',
  marketing_connection_not_found:'اختر الحساب الإعلاني قبل بدء المزامنة.',
  request_rejected:'لم يكتمل الطلب. حاول مجددًا أو تواصل مع الدعم.',
  service_unavailable:'خدمة الربط غير متاحة مؤقتًا. حاول مجددًا.'
};

function initialFeedback(outcome,reason){
  if(outcome==='connected')return {
    tone:'success',message:'اكتمل التفويض. اختر الحساب الإعلاني الذي تريد مشاهدة تقاريره.'
  };
  if(outcome==='cancelled')return {
    tone:'neutral',message:'ألغيت محاولة الربط. لم نغيّر أي اتصال محفوظ.'
  };
  if(outcome==='error')return {
    tone:'error',message:ERRORS[reason]||'لم يكتمل التفويض. يمكنك إعادة المحاولة.'
  };
  return null;
}

export default function SocialConnectV2({
  slug,initialData,initialReport,reportFilters,canManage,outcome,reason,display='all',hideFilters=false
}){
  const router=useRouter();
  const data=initialData||{};
  const [checkedAt]=useState(()=>Date.now());
  const needsReauthorization=connectionNeedsReauthorization(data,checkedAt);
  const state=STATUS[needsReauthorization?'reauth_required':data.status]||STATUS.disabled;
  const [busy,setBusy]=useState('');
  const [feedback,setFeedback]=useState(()=>initialFeedback(outcome,reason));
  const [accounts,setAccounts]=useState(null);
  const selected=data.selectedAccount||null;
  const readyToStart=Boolean(
    canManage&&data.addonEnabled&&data.rolloutEnabled&&data.oauthEnabled
    &&!data.legacyProtected
  );
  const canDisconnect=Boolean(
    canManage&&!data.legacyProtected
    &&['connected','reauth_required','error'].includes(data.status)
  );
  const canLoadAssets=Boolean(
    display!=='performance'&&canManage&&data.status==='connected'&&!needsReauthorization&&!selected
    &&data.assetDiscoveryEnabled&&!data.legacyProtected
  );

  useEffect(()=>{
    if(!canLoadAssets)return;
    const controller=new AbortController();
    fetch('/api/tenant/social-connect/assets',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({tenantSlug:slug}),signal:controller.signal
    }).then(async response=>{
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'request_rejected');
      setAccounts(Array.isArray(result.accounts)?result.accounts:[]);
    }).catch(error=>{
      if(error?.name==='AbortError')return;
      const code=error instanceof Error?error.message:'request_rejected';
      setAccounts([]);
      setFeedback({tone:'error',message:ERRORS[code]||ERRORS.request_rejected});
    });
    return ()=>controller.abort();
  },[canLoadAssets,slug]);

  async function action(name,payload={}){
    await runConnectionAction({
      name,slug,payload,fetcher:fetch,navigate:url=>window.location.assign(url),
      onStart(){setBusy(name);setFeedback(null);},
      onDisconnected(){
        setFeedback({
          tone:'success',
          message:'تم فصل الربط. أزلنا صلاحية وصول أودير المحفوظة لهذا الاتصال.'
        });
        router.refresh();
      },
      onSuccess(result){
        if(name==='select'){
          setFeedback({
            tone:'success',
            message:'تم اختيار الحساب. اضغط «مزامنة الآن» لتحميل الحملات والنتائج.'
          });
        }else if(name==='sync'){
          setFeedback({tone:'success',message:'اكتملت مزامنة الفترة المختارة والحملات والإعلانات الداخلية.'});
        }
        if(result?.ok)router.refresh();
      },
      onError(code){
        setFeedback({tone:'error',message:ERRORS[code]||ERRORS.request_rejected});
      },
      onSettled(){setBusy('');}
    });
  }

  function disconnect(){
    if(!window.confirm(
      'هل تريد فصل الربط؟ سيحتاج أودير إلى موافقتك من جديد للوصول إلى الحساب.'
    ))return;
    action('disconnect');
  }

  const report=initialReport||{};
  const filters=reportFilters||{};
  const summary=report.summary||{};
  const analysis=report.analysis||{};
  const campaigns=Array.isArray(report.campaigns)?report.campaigns:[];
  const ads=Array.isArray(report.ads)?report.ads:[];
  const filterMeta=report.filters||{};
  const range=report.range||{from:filters.dateFrom,to:filters.dateTo};
  const currency=summary.currency||selected?.currency||'SAR';
  const syncRange={dateFrom:range.from,dateTo:range.to};
  return <section className="scv2-page">
    {display==='all'?<header className="scv2-topbar">
      <div>
        <small>إعلانات Meta</small>
        <h1>الحملات والنتائج</h1>
        <p>اربط حسابك مرة واحدة وشاهد أداء الإعلانات داخل أودير بصلاحية قراءة فقط.</p>
      </div>
      <Link href={`/tenant/${encodeURIComponent(slug)}/marketing`}>
        العودة إلى مركز التسويق
      </Link>
    </header>:null}

    {data.legacyProtected?<div className="scv2-legacy-guard">
      <span aria-hidden="true">✓</span>
      <div><b>منشأتك لديها ربط قائم</b><p>تابع اتصالك الحالي من مركز التسويق. هذه الصفحة لا تستبدله.</p></div>
    </div>:null}
    {feedback?<div className={`scv2-alert ${feedback.tone}`}
      role={feedback.tone==='error'?'alert':'status'}>{feedback.message}</div>:null}

    {display!=='performance'?<section className="scv2-grid">
      <article className="scv2-connection-card" aria-busy={Boolean(busy)}>
        <header>
          <span className="scv2-provider-mark" aria-hidden="true">Meta</span>
          <div><small>حساب الإعلانات</small><h2>{selected?.name||'ربط آمن للمشاهدة'}</h2></div>
          <em className={state.tone}>{state.label}</em>
        </header>
        <p>أودير يقرأ الحملات والإنفاق والظهور والنقرات والنتائج فقط. لا يستطيع إنشاء حملة أو تعديل الميزانية أو إيقاف إعلان.</p>
        <dl>
          <div><dt>الصلاحية</dt><dd>ads_read فقط</dd></div>
          <div><dt>الحساب المختار</dt><dd>{selected?.externalAccountId||'—'}</dd></div>
          <div><dt>آخر مزامنة</dt><dd>{formatDate(data.sync?.lastSyncedAt)}</dd></div>
          <div><dt>آخر تفويض</dt><dd>{formatDate(data.lastAuthorizedAt)}</dd></div>
        </dl>
        {needsReauthorization?<p className="scv2-gate-note">انتهت صلاحية الاتصال. أعد ربط الحساب للمتابعة.</p>:null}
        <footer>
          <button className="scv2-primary" disabled={!readyToStart||Boolean(busy)}
            onClick={()=>action('start')}>
            {busy==='start'?'جارٍ فتح Meta…':data.status==='connected'||needsReauthorization
              ?'إعادة ربط الحساب':'ربط حساب Meta'}
          </button>
          {selected&&data.syncEnabled?<button className="scv2-secondary"
            disabled={!canManage||Boolean(busy)||needsReauthorization}
            onClick={()=>action('sync',syncRange)}>
            {busy==='sync'?'جارٍ المزامنة…':'مزامنة الفترة'}
          </button>:null}
          {canDisconnect?<button className="scv2-danger" disabled={Boolean(busy)}
            onClick={disconnect}>
            {busy==='disconnect'?'جارٍ فصل الربط…':'فصل الربط'}
          </button>:null}
        </footer>
        {!canManage?<small className="scv2-gate-note">يمكنك مشاهدة النتائج. يتولى مدير المنشأة إدارة الربط.</small>
          :!data.legacyProtected&&!data.rolloutEnabled?<small className="scv2-gate-note">الربط غير متاح لهذه المنشأة بعد.</small>
            :!data.legacyProtected&&!data.oauthEnabled?<small className="scv2-gate-note">الربط غير متاح حاليًا.</small>:null}
      </article>

      <aside className="scv2-security-card">
        <small>ثلاث خطوات</small>
        <h2>من Meta إلى تقرير واضح</h2>
        <ul>
          <li><span>01</span><div><b>وافق على القراءة</b><p>يتم التفويض داخل صفحة Meta الرسمية.</p></div></li>
          <li><span>02</span><div><b>اختر الحساب</b><p>نُظهر فقط الحسابات المتاحة لنفس التفويض.</p></div></li>
          <li><span>03</span><div><b>شاهد النتائج</b><p>مزامنة يومية مع زر تحديث فوري عند الحاجة.</p></div></li>
        </ul>
      </aside>
    </section>:null}

    {canLoadAssets?<section className="scv2-panel">
      <header><div><small>الخطوة الثانية</small><h2>اختر الحساب الإعلاني</h2></div></header>
      {accounts===null?<p className="scv2-empty">جارٍ تحميل حساباتك من Meta…</p>
        :accounts.length===0?<p className="scv2-empty">لم نجد حسابات إعلانية متاحة لهذا المستخدم.</p>
          :<div className="scv2-account-list">{accounts.map(account=><article key={account.externalAccountId}>
            <div><b>{account.name}</b><small>{account.externalAccountId} · {account.currency}</small></div>
            <button disabled={Boolean(busy)||!data.accountSelectionEnabled}
              onClick={()=>action('select',{externalAccountId:account.externalAccountId})}>
              {busy==='select'?'جارٍ الاختيار…':'اختيار الحساب'}
            </button>
          </article>)}</div>}
    </section>:null}

    {selected&&display!=='connection'?<>
      {hideFilters?<form className="scv2-filters" method="get">
        {Object.entries({from:filters.dateFrom,to:filters.dateTo,asOf:filters.asOf,mode:filters.mode,campaign:filters.campaign,staff:filters.staff,course:filters.course,q:filters.search}).map(([name,value])=><input type="hidden" key={name} name={name} value={value||''}/>)}
        <label>بحث داخل إعلانات Meta<input name="metaQ" defaultValue={filters.metaSearch}/></label>
        <label>حالة إعلان Meta<select name="status" defaultValue={filters.status}><option value="all">الكل</option><option value="active">نشط</option><option value="paused">متوقف</option><option value="other">أخرى</option></select></label>
        <button className="scv2-primary">تصفية تفاصيل Meta</button>
      </form>:null}
      {!hideFilters?<section className="scv2-panel scv2-report-panel">
        <header><div><small>التقارير والتحليل</small><h2>حدد الفترة والإعلانات التي تريدها</h2></div>
          <span>حتى 93 يومًا في المزامنة الواحدة</span></header>
        <nav className="scv2-quick-ranges" aria-label="فترات سريعة">
          <QuickRange slug={slug} filters={filters} days={1} label="اليوم"/>
          <QuickRange slug={slug} filters={filters} days={7} label="آخر 7 أيام"/>
          <QuickRange slug={slug} filters={filters} days={30} label="آخر 30 يومًا"/>
          <QuickRange slug={slug} filters={filters} days={90} label="آخر 90 يومًا"/>
        </nav>
        <form className="scv2-filters" method="get">
          <label><span>من تاريخ</span><input type="date" name="from" required
            defaultValue={filters.dateFrom} max={filters.today}/></label>
          <label><span>إلى تاريخ</span><input type="date" name="to" required
            defaultValue={filters.dateTo} max={filters.today}/></label>
          <label className="scv2-search"><span>إعلان بعينه</span><input name="metaQ"
            defaultValue={filters.metaSearch} placeholder="ابحث باسم الإعلان أو رقمه"/></label>
          <label><span>الحملة</span><select name="campaign" defaultValue={filters.campaign}>
            <option value="">كل الحملات</option>
            {(filterMeta.campaigns||[]).map(campaign=><option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>)}
          </select></label>
          <label><span>الحالة</span><select name="status" defaultValue={filters.status}>
            <option value="all">كل الحالات</option><option value="active">نشط</option>
            <option value="paused">متوقف</option><option value="other">أخرى</option>
          </select></label>
          <div className="scv2-filter-actions">
            <button className="scv2-primary" type="submit">تطبيق الفلاتر</button>
            <Link href={`/tenant/${encodeURIComponent(slug)}/reports/campaigns`}>مسح</Link>
          </div>
        </form>
        <div className="scv2-range-actions">
          <p>النتائج المعروضة من <b>{formatDay(range.from)}</b> إلى <b>{formatDay(range.to)}</b>.</p>
          {canManage&&data.syncEnabled?<button className="scv2-secondary" disabled={Boolean(busy)||needsReauthorization}
            onClick={()=>action('sync',syncRange)}>{busy==='sync'?'جارٍ تحميل الفترة…':'تحميل/تحديث هذه الفترة من Meta'}</button>:null}
        </div>
        {report.metricRows===0?<p className="scv2-empty scv2-empty-warning">
          لا توجد نتائج مخزنة لهذه الفترة. اضغط «تحميل/تحديث هذه الفترة من Meta» لجلب بياناتها، أو اختر فترة شهدت إنفاقًا فعليًا.
        </p>:null}
      </section>:null}

      <section className="scv2-metrics" aria-label="ملخص الفترة المختارة">
        <Metric label="الإنفاق" value={formatMoney(summary.spendMinor,currency)}/>
        <Metric label="مرات الظهور" value={formatNumber(summary.impressions)}/>
        <Metric label="الوصول الفريد للفترة" value="غير قابل للجمع اليومي"/>
        <Metric label="النقرات" value={formatNumber(summary.clicks)}/>
        <Metric label="CTR" value={summary.ctr==null?'—':`${formatNumber(summary.ctr)}%`}/>
        <Metric label="نتائج Meta" value={formatNumber(summary.platformConversions)}/>
        <Metric label="تكلفة النتيجة" value={summary.cpaMinor==null?'—':formatMoney(summary.cpaMinor,currency)}/>
        <Metric label="قيمة النتائج وفق Meta" value={formatMoney(summary.platformRevenueMinor,currency)}/>
      </section>

      <section className="scv2-panel">
        <header><div><small>قراءة سريعة للفترة</small><h2>التحليل</h2></div>
          <span>{formatNumber(analysis.adsWithData)} إعلانًا لديه بيانات</span></header>
        <div className="scv2-analysis">
          <Insight label="الأعلى إنفاقًا" item={analysis.topSpendAd}
            value={analysis.topSpendAd?formatMoney(analysis.topSpendAd.spendMinor,currency):'—'}/>
          <Insight label="أفضل CTR" item={analysis.bestCtrAd}
            value={analysis.bestCtrAd?`${formatNumber(analysis.bestCtrAd.ctr)}%`:'—'}/>
          <Insight label="الأكثر نتائج" item={analysis.topResultsAd}
            value={analysis.topResultsAd?formatNumber(analysis.topResultsAd.results):'—'}/>
          <Insight label="إنفاق بلا نتائج" item={{name:`${formatNumber(analysis.zeroResultAds)} إعلان`}}
            value={formatMoney(analysis.zeroResultSpendMinor,currency)} tone="warning"/>
        </div>
        <p className="scv2-analysis-note">التحليل وصفي ومبني على أرقام الفترة والفلاتر المختارة؛ لا يغيّر أي إعلان أو ميزانية.</p>
      </section>

      <section className="scv2-panel">
        <header><div><small>ملخص مجمّع</small><h2>أداء الحملات</h2></div><span>{campaigns.length} حملة مطابقة</span></header>
        {campaigns.length===0?<p className="scv2-empty">لا توجد حملات مطابقة للفلاتر الحالية.</p>
          :<div className="scv2-table-wrap"><table><thead><tr>
            <th>الحملة</th><th>الإعلانات</th><th>الحالة</th><th>الإنفاق</th><th>الظهور</th><th>النقرات</th><th>CTR</th><th>النتائج</th>
          </tr></thead><tbody>{campaigns.map(campaign=><tr key={campaign.id}>
            <td><b>{campaign.name}</b><small>{campaign.objective||'—'}</small></td>
            <td>{formatNumber(campaign.adCount)}</td><td>{statusLabel(campaign.effectiveStatus||campaign.status)}</td>
            <td>{formatMoney(campaign.spendMinor,campaign.currency)}</td>
            <td>{formatNumber(campaign.impressions)}</td>
            <td>{formatNumber(campaign.clicks)}</td>
            <td>{campaign.ctr==null?'—':`${formatNumber(campaign.ctr)}%`}</td>
            <td>{formatNumber(campaign.platformConversions)}</td>
          </tr>)}</tbody></table></div>}
      </section>

      <section className="scv2-panel">
        <header><div><small>الإعلانات الداخلية</small><h2>أداء كل إعلان</h2></div>
          <span>{formatNumber(filterMeta.totalAds)} إعلان مطابق</span></header>
        {ads.length===0?<p className="scv2-empty">لا توجد إعلانات مطابقة. غيّر البحث أو الفلاتر، ثم حدّث الفترة عند الحاجة.</p>
          :<div className="scv2-table-wrap"><table className="scv2-ads-table"><thead><tr>
            <th>الإعلان</th><th>الحملة / المجموعة</th><th>الحالة</th><th>الإنفاق</th><th>الظهور</th><th>النقرات</th><th>CTR</th><th>النتائج</th><th>تكلفة النتيجة</th>
          </tr></thead><tbody>{ads.map(ad=><tr key={ad.id}>
            <td><b>{ad.name}</b><small>ID: {ad.externalAdId}</small></td>
            <td><b>{ad.campaignName}</b><small>{ad.adGroupName||'بدون مجموعة إعلانية'}</small></td>
            <td><span className={`scv2-status ${statusTone(ad.effectiveStatus||ad.status)}`}>{statusLabel(ad.effectiveStatus||ad.status)}</span></td>
            <td>{formatMoney(ad.spendMinor,ad.currency)}</td><td>{formatNumber(ad.impressions)}</td>
            <td>{formatNumber(ad.clicks)}</td><td>{ad.ctr==null?'—':`${formatNumber(ad.ctr)}%`}</td>
            <td>{formatNumber(ad.platformConversions)}</td>
            <td>{ad.cpaMinor==null?'—':formatMoney(ad.cpaMinor,ad.currency)}</td>
          </tr>)}</tbody></table></div>}
        <Pagination slug={slug} filters={filters} current={filterMeta.page} total={filterMeta.totalPages}/>
      </section>
    </>:null}
  </section>;
}

function Metric({label,value}){
  return <article><small>{label}</small><b>{value}</b></article>;
}

function Insight({label,item,value,tone=''}){
  return <article className={tone}><small>{label}</small><b>{value}</b><p>{item?.name||'لا توجد بيانات كافية'}</p></article>;
}

function QuickRange({slug,filters,days,label}){
  const to=filters.today;
  const date=new Date(`${to}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()-(days-1));
  const from=date.toISOString().slice(0,10);
  const active=filters.dateFrom===from&&filters.dateTo===to;
  return <Link className={active?'active':''}
    href={socialReportHref(slug,filters,{dateFrom:from,dateTo:to,page:1})}>{label}</Link>;
}

function Pagination({slug,filters,current,total}){
  const page=Number(current||1),pages=Number(total||0);
  if(pages<=1)return null;
  return <nav className="scv2-pagination" aria-label="صفحات الإعلانات">
    {page>1?<Link href={socialReportHref(slug,filters,{page:page-1})}>السابق</Link>:<span/>}
    <b>صفحة {formatNumber(page)} من {formatNumber(pages)}</b>
    {page<pages?<Link href={socialReportHref(slug,filters,{page:page+1})}>التالي</Link>:<span/>}
  </nav>;
}

function statusLabel(value){
  const status=String(value||'').toLowerCase();
  if(status==='active')return 'نشط';
  if(['paused','campaign_paused','adset_paused'].includes(status))return 'متوقف';
  if(status==='archived')return 'مؤرشف';
  if(status==='deleted')return 'محذوف';
  return status||'—';
}

function statusTone(value){
  const status=String(value||'').toLowerCase();
  if(status==='active')return 'ready';
  if(['paused','campaign_paused','adset_paused'].includes(status))return 'warning';
  return 'muted';
}

function formatDay(value){
  if(!value)return '—';
  const date=new Date(`${value}T00:00:00Z`);
  if(Number.isNaN(date.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{dateStyle:'medium',timeZone:'UTC'}).format(date);
}

function formatNumber(value){
  if(value==null)return '—';
  const number=Number(value||0);
  return new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(
    Number.isFinite(number)?number:0
  );
}

function formatMoney(value,currency='SAR'){
  if(value==null)return '—';
  const safeCurrency=/^[A-Z]{3}$/.test(String(currency||''))?currency:'SAR';
  const digits=new Intl.NumberFormat('en',{style:'currency',currency:safeCurrency})
    .resolvedOptions().maximumFractionDigits??2;
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency:safeCurrency,maximumFractionDigits:digits
  }).format(Number(value||0)/(10**digits));
}

function formatDate(value){
  if(!value)return '—';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{
    dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'
  }).format(date);
}
