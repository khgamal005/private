'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect,useState} from 'react';
import {
  connectionNeedsReauthorization,runConnectionAction
} from '../lib/social-connect-v2.mjs';

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

export default function SocialConnectV2({slug,initialData,canManage,outcome,reason}){
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
    canManage&&data.status==='connected'&&!needsReauthorization&&!selected
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
          setFeedback({tone:'success',message:'اكتملت مزامنة أحدث الحملات والنتائج.'});
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

  const summary=data.summary||{};
  const campaigns=Array.isArray(data.campaigns)?data.campaigns:[];
  return <main className="scv2-page">
    <header className="scv2-topbar">
      <div>
        <small>إعلانات Meta</small>
        <h1>الحملات والنتائج</h1>
        <p>اربط حسابك مرة واحدة وشاهد أداء الإعلانات داخل أودير بصلاحية قراءة فقط.</p>
      </div>
      <Link href={`/tenant/${encodeURIComponent(slug)}/marketing`}>
        العودة إلى مركز التسويق
      </Link>
    </header>

    {data.legacyProtected?<div className="scv2-legacy-guard">
      <span aria-hidden="true">✓</span>
      <div><b>منشأتك لديها ربط قائم</b><p>تابع اتصالك الحالي من مركز التسويق. هذه الصفحة لا تستبدله.</p></div>
    </div>:null}
    {feedback?<div className={`scv2-alert ${feedback.tone}`}
      role={feedback.tone==='error'?'alert':'status'}>{feedback.message}</div>:null}

    <section className="scv2-grid">
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
            onClick={()=>action('sync')}>
            {busy==='sync'?'جارٍ المزامنة…':'مزامنة الآن'}
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
    </section>

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

    {selected?<>
      <section className="scv2-metrics" aria-label="ملخص آخر 30 يومًا">
        <Metric label="الإنفاق" value={formatMoney(summary.spendMinor,summary.currency||selected.currency)}/>
        <Metric label="مرات الظهور" value={formatNumber(summary.impressions)}/>
        <Metric label="النقرات" value={formatNumber(summary.clicks)}/>
        <Metric label="CTR" value={summary.ctr==null?'—':`${formatNumber(summary.ctr)}%`}/>
        <Metric label="النتائج" value={formatNumber(summary.platformConversions)}/>
        <Metric label="قيمة النتائج" value={formatMoney(summary.platformRevenueMinor,summary.currency||selected.currency)}/>
      </section>
      <section className="scv2-panel">
        <header><div><small>آخر 30 يومًا</small><h2>أداء الحملات</h2></div><span>{campaigns.length} حملة</span></header>
        {campaigns.length===0?<p className="scv2-empty">لا توجد بيانات بعد. اضغط «مزامنة الآن» لتحميل الحملات.</p>
          :<div className="scv2-table-wrap"><table><thead><tr>
            <th>الحملة</th><th>الحالة</th><th>الإنفاق</th><th>الظهور</th><th>النقرات</th><th>النتائج</th>
          </tr></thead><tbody>{campaigns.map(campaign=><tr key={campaign.id}>
            <td><b>{campaign.name}</b><small>{campaign.objective||'—'}</small></td>
            <td>{campaign.effectiveStatus||campaign.status||'—'}</td>
            <td>{formatMoney(campaign.spendMinor,campaign.currency)}</td>
            <td>{formatNumber(campaign.impressions)}</td>
            <td>{formatNumber(campaign.clicks)}</td>
            <td>{formatNumber(campaign.platformConversions)}</td>
          </tr>)}</tbody></table></div>}
      </section>
    </>:null}
  </main>;
}

function Metric({label,value}){
  return <article><small>{label}</small><b>{value}</b></article>;
}

function formatNumber(value){
  const number=Number(value||0);
  return new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(
    Number.isFinite(number)?number:0
  );
}

function formatMoney(value,currency='SAR'){
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
