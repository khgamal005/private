'use client';

import {memo,useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './marketing-command-center.module.css';

const STATUS_LABELS={
  draft:'محفوظ ويحتاج اختبارًا',active:'متصل',degraded:'متصل مع ملاحظات',
  error:'يحتاج مراجعة',reauth_required:'أعد التفويض',disabled:'متوقف'
};
const RUN_LABELS={
  running:'جارية',queued:'في الانتظار',success:'ناجحة',partial:'جزئية',failed:'فشلت'
};
const PROVIDER_META={
  meta:{short:'M',className:'meta',channel:'Facebook + Instagram'},
  google_ads:{short:'G',className:'google',channel:'Search + YouTube + PMax'},
  tiktok_ads:{short:'T',className:'tiktok',channel:'TikTok for Business'},
  snapchat_ads:{short:'S',className:'snapchat',channel:'Snapchat Ads'}
};
const FIELD_LABELS={
  accountId:'معرّف حساب Meta الإعلاني',businessId:'معرّف Business Manager (اختياري)',
  customerId:'Google Ads Customer ID',loginCustomerId:'Manager Account ID (اختياري)',
  advertiserId:'TikTok Advertiser ID',adAccountId:'Snapchat Ad Account ID',
  organizationId:'Snap Organization ID (اختياري)',accessToken:'Access Token',
  refreshToken:'Refresh Token',developerToken:'Google Ads Developer Token',
  clientId:'OAuth Client ID',clientSecret:'OAuth Client Secret',appId:'App ID',
  appSecret:'App Secret',secret:'App Secret'
};
const SECRET_FIELDS=new Set([
  'accessToken','refreshToken','developerToken','clientId','clientSecret',
  'appId','appSecret','secret'
]);
const MODEL_LABELS={
  last_non_direct:'آخر تفاعل غير مباشر',last_touch:'آخر تفاعل',
  first_touch:'أول تفاعل',linear:'إسناد خطّي'
};

const NUMBER_FORMATTERS=new Map();
const MONEY_FORMATTERS=new Map();
const DATE_TIME_FORMATTER=new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{
  calendar:'gregory',timeZone:'Asia/Riyadh',
  day:'numeric',month:'short',hour:'numeric',minute:'2-digit'
});
const SHORT_DATE_FORMATTER=new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{
  calendar:'gregory',timeZone:'UTC',day:'numeric',month:'short'
});

function number(value,maximumFractionDigits=1){
  let formatter=NUMBER_FORMATTERS.get(maximumFractionDigits);
  if(!formatter){
    formatter=new Intl.NumberFormat('ar-EG',{maximumFractionDigits});
    NUMBER_FORMATTERS.set(maximumFractionDigits,formatter);
  }
  return formatter.format(Number(value)||0);
}

function money(value,currency='SAR'){
  try{
    let formatter=MONEY_FORMATTERS.get(currency);
    if(!formatter){
      formatter=new Intl.NumberFormat('ar-SA',{
        style:'currency',currency,maximumFractionDigits:0
      });
      MONEY_FORMATTERS.set(currency,formatter);
    }
    return formatter.format((Number(value)||0)/100);
  }catch{
    return `${number((Number(value)||0)/100,0)} ${currency}`;
  }
}

function ratio(value,suffix='×'){
  if(value===null||value===undefined)return '—';
  return `${number(value,2)}${suffix}`;
}

function percent(value){
  if(value===null||value===undefined)return '—';
  return `${number(value,1)}٪`;
}

function dateTime(value){
  if(!value)return 'لم تتم بعد';
  return DATE_TIME_FORMATTER.format(new Date(value));
}

function scheduleLabel(connection){
  if(!connection||connection.frequency==='manual')return 'يدوي';
  const frequency=connection.frequency==='every_6_hours'?'كل 6 ساعات':'يومي';
  const value=/^\d{2}:\d{2}$/.test(String(connection.syncTime||''))
    ?connection.syncTime
    :'03:00';
  const [hour,minute]=value.split(':').map(Number);
  const time=new Intl.DateTimeFormat('ar-SA',{
    hour:'numeric',minute:'2-digit',timeZone:'UTC'
  }).format(new Date(Date.UTC(2020,0,1,hour,minute)));
  return `${frequency} · ${time} بتوقيت السعودية`;
}

function shortDate(value){
  if(!value)return '—';
  return SHORT_DATE_FORMATTER.format(
    new Date(`${String(value).slice(0,10)}T12:00:00Z`)
  );
}

function isoDate(value){
  return value.toISOString().slice(0,10);
}

function quickRange(days,toValue){
  const to=toValue?new Date(`${toValue}T12:00:00Z`):new Date();
  const from=new Date(to);
  from.setUTCDate(from.getUTCDate()-days+1);
  return `?from=${isoDate(from)}&to=${isoDate(to)}`;
}

function providerMeta(key){
  return PROVIDER_META[key]||{short:'A',className:'generic',channel:'Ads API'};
}

function metricCards(summary){
  const currency=summary?.currency||'SAR';
  const platformCpl=summary?.platformCplMinor==null
    ?'—'
    :money(summary.platformCplMinor,currency);
  return [
    {key:'spend',label:'الإنفاق الإعلاني',value:money(summary?.spendMinor,currency),note:`${number(summary?.clicks)} نقرة`,tone:'navy'},
    {key:'platformLeads',label:'نتائج المنصات',value:number(summary?.platformLeads,0),note:`${number(summary?.platformConversions,0)} تحويلات أبلغت بها المنصات`,tone:'blue'},
    {key:'platformRoas',label:'ROAS حسب المنصات',value:ratio(summary?.platformRoas),note:`CPL حسب المنصة ${platformCpl}`,tone:'violet'},
    {key:'verifiedLeads',label:'عملاء CRM الموثقون',value:number(summary?.leads,0),note:`${number(summary?.qualifiedLeads,0)} مؤهلون`,tone:'cyan'},
    {key:'revenue',label:'الإيراد الموثق المنسوب',value:money(summary?.revenueMinor,currency),note:`${number(summary?.sales)} مبيعات موثقة`,tone:'green'},
    {key:'verifiedRoas',label:'ROAS الموثق',value:ratio(summary?.roas),note:'من المبيعات الفعلية بعد المرتجعات',tone:'amber'}
  ];
}

function chartBuckets(rows=[],maxBuckets=18){
  if(rows.length<=maxBuckets)return rows;
  const size=Math.ceil(rows.length/maxBuckets);
  const result=[];
  for(let index=0;index<rows.length;index+=size){
    const group=rows.slice(index,index+size);
    result.push({
      date:group[0].date,
      endDate:group.at(-1).date,
      spendMinor:group.reduce((sum,row)=>sum+(Number(row.spendMinor)||0),0),
      revenueMinor:group.reduce((sum,row)=>sum+(Number(row.revenueMinor)||0),0),
      leads:group.reduce((sum,row)=>sum+(Number(row.leads)||0),0),
      sales:group.reduce((sum,row)=>sum+(Number(row.sales)||0),0)
    });
  }
  return result;
}


function sumMetric(rows,key){
  return rows.reduce((total,row)=>total+(Number(row?.[key])||0),0);
}

function buildPlatformAnalysis(provider,campaigns,sources,insights){
  const rows=campaigns.filter(row=>row.providerKey===provider.providerKey);
  const source=sources.find(row=>row.providerKey===provider.providerKey)||{};
  const spendMinor=Number(source.spendMinor)||sumMetric(rows,'spendMinor');
  const platformLeads=Number(source.platformLeads)||sumMetric(rows,'platformLeads');
  const platformConversions=Number(source.platformConversions)
    ||sumMetric(rows,'platformConversions');
  const platformRevenueMinor=Number(source.platformRevenueMinor)
    ||sumMetric(rows,'platformRevenueMinor');
  const revenueMinor=Number(source.revenueMinor)||sumMetric(rows,'revenueMinor');
  const leads=Number(source.leads)||sumMetric(rows,'leads');
  const sales=Number(source.sales)||sumMetric(rows,'sales');
  const qualifiedLeads=sumMetric(rows,'qualifiedLeads');
  const impressions=sumMetric(rows,'impressions');
  const clicks=sumMetric(rows,'clicks');
  const activeCampaigns=rows.filter(row=>
    ['active','enabled'].includes(String(row.status||'').toLowerCase())
    ||['active','enabled'].includes(String(row.effectiveStatus||'').toLowerCase())
  ).length;
  const confidenceRows=rows.filter(row=>row.confidenceScore!=null);
  const confidenceScore=confidenceRows.length
    ?confidenceRows.reduce((total,row)=>total+(Number(row.confidenceScore)||0),0)
      /confidenceRows.length
    :null;
  const topCampaign=rows.filter(row=>
    (Number(row.spendMinor)||0)>0
    ||(Number(row.platformLeads)||0)>0
    ||(Number(row.platformConversions)||0)>0
  ).slice().sort((a,b)=>
    (Number(b.platformConversions)||0)-(Number(a.platformConversions)||0)
    ||(Number(b.platformLeads)||0)-(Number(a.platformLeads)||0)
    ||(Number(b.platformRoas)||0)-(Number(a.platformRoas)||0)
    ||(Number(b.roas)||0)-(Number(a.roas)||0)
  )[0]||null;
  const weakCampaign=rows.filter(row=>
    (Number(row.spendMinor)||0)>0
  ).slice().sort((a,b)=>
    ((Number(a.platformConversions)||0)+(Number(a.platformLeads)||0))
      -((Number(b.platformConversions)||0)+(Number(b.platformLeads)||0))
    ||(Number(b.platformCplMinor)||0)-(Number(a.platformCplMinor)||0)
    ||(Number(b.spendMinor)||0)-(Number(a.spendMinor)||0)
  )[0]||null;
  return {
    providerKey:provider.providerKey,nameAr:provider.nameAr,
    connection:provider.connection,channel:providerMeta(provider.providerKey).channel,
    campaigns:rows,
    insights:insights.filter(item=>item.providerKey===provider.providerKey),
    hasData:rows.length>0||spendMinor>0||platformLeads>0
      ||platformConversions>0||leads>0||sales>0,
    spendMinor,platformLeads,platformConversions,platformRevenueMinor,
    revenueMinor,leads,qualifiedLeads,sales,
    impressions,clicks,activeCampaigns,campaignCount:rows.length,
    confidenceScore,topCampaign,weakCampaign,
    platformRoas:spendMinor>0?platformRevenueMinor/spendMinor:null,
    platformCplMinor:platformLeads>0?spendMinor/platformLeads:null,
    platformCostPerConversionMinor:platformConversions>0
      ?spendMinor/platformConversions
      :null,
    platformLeadToConversionRate:platformLeads>0
      ?100*platformConversions/platformLeads
      :null,
    roas:spendMinor>0?revenueMinor/spendMinor:null,
    ctr:impressions>0?100*clicks/impressions:null,
    cpcMinor:clicks>0?spendMinor/clicks:null,
    cplMinor:leads>0?spendMinor/leads:null,
    cacMinor:sales>0?spendMinor/sales:null,
    qualificationRate:leads>0?100*qualifiedLeads/leads:null,
    leadToSaleRate:leads>0?100*sales/leads:null
  };
}

function analysisDecision(analysis){
  if(!analysis?.hasData)return {tone:'neutral',label:'بانتظار البيانات',text:'اختبر الاتصال وشغّل المزامنة لتظهر قراءة هذه المنصة.'};
  if(analysis.sales>0&&(analysis.roas||0)>=2)return {tone:'good',label:'أداء موثّق جيد',text:'المبيعات والإيراد الموثقان يحققان عائدًا جيدًا؛ راقب CAC قبل التوسع.'};
  if(analysis.sales>0&&(analysis.roas||0)<1)return {tone:'risk',label:'العائد الموثق دون التعادل',text:'الإيراد الموثق أقل من الإنفاق؛ راجع الحملات والإسناد قبل زيادة الميزانية.'};
  if(analysis.platformLeads>0||analysis.platformConversions>0)return {tone:'watch',label:'نتائج تحتاج توثيقًا',text:'المنصة تسجّل نتائج فعلية، لكن يلزم ربط المتجر أو توحيد CRM لتأكيد المبيعات والإيراد.'};
  if(analysis.spendMinor>0)return {tone:'risk',label:'مراجعة عاجلة',text:'يوجد إنفاق دون نتائج مسجلة حتى داخل المنصة؛ راجع التتبع والاستهداف قبل زيادة الميزانية.'};
  return {tone:'watch',label:'تحتاج تحسينًا',text:'البيانات محدودة؛ شغّل المزامنة وراجع التتبع قبل اتخاذ قرار ميزانية.'};
}

export default function MarketingCommandCenter({slug,initialData,canManage}){
  const router=useRouter();
  const providers=useMemo(
    ()=>(initialData?.providers||[]).slice().sort(
      (a,b)=>(a.sortOrder??100)-(b.sortOrder??100)
    ),
    [initialData]
  );
  const [selectedKey,setSelectedKey]=useState(null);
  const [modal,setModal]=useState('');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [sourceFilter,setSourceFilter]=useState('all');
  const [sortKey,setSortKey]=useState('spend');
  const [analysisKey,setAnalysisKey]=useState('all');
  const selected=providers.find(provider=>provider.providerKey===selectedKey)||null;
  const summary=useMemo(()=>initialData?.summary||{},[initialData?.summary]);
  const cards=useMemo(
    ()=>metricCards({...summary,model:initialData?.settings?.model}),
    [summary,initialData?.settings?.model]
  );
  const currency=summary.currency||initialData?.settings?.baseCurrency||'SAR';
  const range=initialData?.range||{};
  const activeConnections=providers.filter(provider=>
    ['active','degraded'].includes(provider.connection?.status)
  ).length;
  const connectedCount=providers.filter(provider=>provider.connection).length;
  const platformAnalyses=useMemo(
    ()=>providers.map(provider=>buildPlatformAnalysis(
      provider,initialData?.campaigns||[],initialData?.sources||[],
      initialData?.insights||[]
    )),
    [providers,initialData?.campaigns,initialData?.sources,initialData?.insights]
  );

  const campaigns=useMemo(()=>{
    const query=search.trim().toLowerCase();
    const filtered=(initialData?.campaigns||[]).filter(item=>
      (sourceFilter==='all'||item.providerKey===sourceFilter)
      &&(!query||`${item.name} ${item.accountName}`.toLowerCase().includes(query))
    );
    return filtered.slice().sort((a,b)=>{
      if(sortKey==='roas')return (Number(b.roas)||0)-(Number(a.roas)||0);
      if(sortKey==='revenue')return (Number(b.revenueMinor)||0)-(Number(a.revenueMinor)||0);
      if(sortKey==='leads')return (Number(b.platformLeads)||0)-(Number(a.platformLeads)||0)||(Number(b.leads)||0)-(Number(a.leads)||0);
      return (Number(b.spendMinor)||0)-(Number(a.spendMinor)||0);
    });
  },[initialData?.campaigns,search,sourceFilter,sortKey]);

  useEffect(()=>{
    if(!modal)return undefined;
    const previous=document.body.style.overflow;
    const onKey=event=>{
      if(event.key==='Escape'&&!busy){setModal('');setSelectedKey(null);}
    };
    document.body.style.overflow='hidden';
    window.addEventListener('keydown',onKey);
    return ()=>{
      document.body.style.overflow=previous;
      window.removeEventListener('keydown',onKey);
    };
  },[modal,busy]);

  async function call(provider,action,payload={}){
    const response=await fetch(`/api/marketing/${provider}/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({tenantSlug:slug,payload})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data||result;
  }

  function openProvider(provider){
    setNotice('');setError('');setSelectedKey(provider.providerKey);setModal('provider');
  }

  async function saveProvider(event){
    event.preventDefault();
    if(!selected)return;
    setBusy('save');setError('');setNotice('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      const configuration={};
      const secrets={};
      for(const key of [
        ...(selected.requiredConfigKeys||[]),...(selected.optionalConfigKeys||[])
      ]){
        const value=String(values[key]||'').trim();
        if(value)configuration[key]=value;
      }
      for(const key of [
        ...(selected.requiredSecretKeys||[]),...(selected.optionalSecretKeys||[])
      ]){
        const value=String(values[key]||'').trim();
        if(value)secrets[key]=value;
      }
      await call(selected.providerKey,'save',{
        displayName:String(values.displayName||selected.nameAr).trim(),
        frequency:String(values.frequency||'daily'),
        syncTime:String(values.syncTime||'03:00'),
        syncTimezone:'Asia/Riyadh',
        syncLookbackDays:Number(values.syncLookbackDays)||14,
        apiVersion:String(values.apiVersion||selected.apiVersion||''),
        configuration,secrets
      });
      setModal('');setSelectedKey(null);
      setNotice(`تم حفظ اتصال ${selected.nameAr} في الخزنة. اختبره قبل أول مزامنة.`);
      router.refresh();
    }catch(reason){setError(reason.message);}finally{setBusy('');}
  }

  async function runProvider(provider,action){
    setBusy(`${action}:${provider.providerKey}`);setError('');setNotice('');
    try{
      const result=await call(provider.providerKey,action,{
        dateFrom:range.from,dateTo:range.to
      });
      if(action==='test'){
        const identity=result.identity||{};
        setNotice(`تم التحقق من ${provider.nameAr}${identity.name?` — ${identity.name}`:''}.`);
      }else{
        const stats=result.stats||{};
        setNotice(
          `اكتملت مزامنة ${provider.nameAr}: ${number(stats.campaigns,0)} حملة و`
          +`${number(stats.metrics,0)} سجل أداء، ثم أُعيد احتساب الإسناد.`
        );
      }
      router.refresh();
    }catch(reason){setError(reason.message);}finally{setBusy('');}
  }

  async function toggleProvider(provider){
    const enabling=provider.connection?.status==='disabled';
    if(!enabling&&!window.confirm(
      `إيقاف ${provider.nameAr}؟ ستظل البيانات والرموز المشفّرة محفوظة.`
    ))return;
    setBusy(`toggle:${provider.providerKey}`);setError('');setNotice('');
    try{
      await call(provider.providerKey,enabling?'enable':'disable');
      setNotice(`تم ${enabling?'تفعيل':'إيقاف'} اتصال ${provider.nameAr}.`);
      router.refresh();
    }catch(reason){setError(reason.message);}finally{setBusy('');}
  }

  async function saveSettings(event){
    event.preventDefault();
    setBusy('settings');setError('');setNotice('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      await call('system','save-settings',{
        model:String(values.model||'last_non_direct'),
        clickWindowDays:Number(values.clickWindowDays)||30,
        viewWindowDays:Number(values.viewWindowDays)||1,
        baseCurrency:String(values.baseCurrency||'SAR').trim().toUpperCase(),
        timezone:String(values.timezone||'Asia/Riyadh').trim()
      });
      setModal('');
      setNotice('تم حفظ سياسة الإسناد. ستُطبّق عند المزامنة التالية.');
      router.refresh();
    }catch(reason){setError(reason.message);}finally{setBusy('');}
  }

  async function resolveInsight(insight,status='resolved'){
    setBusy(`insight:${insight.id}`);setError('');
    try{
      await call('system','insight-status',{insightId:insight.id,status});
      setNotice(status==='resolved'?'تم إغلاق التوصية.':'تم تأجيل التوصية.');
      router.refresh();
    }catch(reason){setError(reason.message);}finally{setBusy('');}
  }

  return <section className={styles.center} aria-labelledby="marketing-title">
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}><i/> MARKTONE GROWTH INTELLIGENCE</span>
        <h2 id="marketing-title">مركز قرار الحملات</h2>
        <p>
          الإنفاق من منصات الإعلان الرسمية، والعملاء من CRM، والمبيعات الفعلية
          من المتجر — في قراءة واحدة تصلح لاتخاذ القرار.
        </p>
        <div className={styles.heroBadges}>
          <span>API رسمي فقط</span><span>إسناد First‑Party</span>
          <span>الإيراد بعد المرتجعات</span><span>عزل كامل لكل منشأة</span>
        </div>
      </div>
      <div className={styles.heroScore}>
        <span>ROAS الموثّق</span>
        <strong>{ratio(summary.roas)}</strong>
        <small>{money(summary.revenueMinor,currency)} من {money(summary.spendMinor,currency)}</small>
      </div>
    </header>

    <div className={styles.toolbar}>
      <div className={styles.quickRanges}>
        <a href={quickRange(7,range.to)}>7 أيام</a>
        <a href={quickRange(30,range.to)}>30 يومًا</a>
        <a href={quickRange(90,range.to)}>90 يومًا</a>
      </div>
      <form method="get" className={styles.periodForm}>
        <label><span>من</span><input type="date" name="from" defaultValue={range.from||''}/></label>
        <label><span>إلى</span><input type="date" name="to" defaultValue={range.to||''}/></label>
        <button type="submit">تحديث القرار</button>
      </form>
      {canManage&&<button className={styles.settingsButton} type="button" onClick={()=>setModal('settings')}>سياسة الإسناد</button>}
    </div>

    {initialData?.degraded&&<div className={styles.warningBanner}>
      <b>تعذر تحميل آخر لقطة من البيانات</b>
      <span>الواجهة متاحة، لكن لا تُتخذ قرارات إنفاق قبل عودة الاتصال بقاعدة البيانات.</span>
    </div>}
    {!initialData?.featureEnabled&&<div className={styles.upgradeBanner}>
      <b>مركز الحملات غير مفعّل في الباقة الحالية</b>
      <span>يمكن استعراض التصميم، ويلزم تفعيل إضافة إدارة الحملات لربط الحسابات والمزامنة.</span>
    </div>}
    {notice&&<div className={styles.notice}>{notice}</div>}
    {error&&!modal&&<div className={styles.error}>{error}</div>}

    <div className={styles.metrics}>
      {cards.map(item=><article key={item.key} className={`${styles.metric} ${styles[item.tone]}`}>
        <span>{item.label}</span><b>{item.value}</b><small>{item.note}</small>
      </article>)}
    </div>

    <PlatformAnalytics
      analyses={platformAnalyses}
      selectedKey={analysisKey}
      onSelect={setAnalysisKey}
      currency={currency}
      summary={summary}
    />

    <DataHealth
      data={initialData?.dataHealth||{}}
      activeConnections={activeConnections}
      connectedCount={connectedCount}
      commerceSources={initialData?.commerceSources||[]}
    />

    <section className={styles.section}>
      <SectionHead eyebrow="مصادر الإنفاق" title="الحسابات الإعلانية الرسمية" note="المفاتيح مشفّرة، والموصلات للقراءة والتحليل فقط."/>
      <div className={styles.providerGrid}>
        {providers.map(provider=><ProviderCard
          key={provider.providerKey}
          provider={provider}
          canManage={canManage&&initialData?.featureEnabled!==false}
          busy={busy}
          onOpen={()=>openProvider(provider)}
          onTest={()=>runProvider(provider,'test')}
          onSync={()=>runProvider(provider,'sync')}
          onToggle={()=>toggleProvider(provider)}
        />)}
      </div>
    </section>

    <div className={styles.decisionGrid}>
      <PerformanceChart rows={initialData?.daily||[]} currency={currency}/>
      <DecisionPanel
        insights={initialData?.insights||[]}
        busy={busy}
        canManage={canManage}
        onResolve={resolveInsight}
      />
    </div>

    <div className={styles.breakdownGrid}>
      <SourcePerformance sources={initialData?.sources||[]} currency={currency}/>
      <Funnel rows={initialData?.funnel||[]}/>
      <CommerceSources rows={initialData?.commerceSources||[]}/>
    </div>

    <section className={`${styles.section} ${styles.campaignSection}`}>
      <SectionHead eyebrow="وحدة القرار" title="الحملات: أين نزيد وأين نراجع؟" note="ROAS هنا مبني على الإيراد الفعلي المنسوب، لا على رقم المنصة وحده."/>
      <div className={styles.tableToolbar}>
        <input value={search} onChange={event=>setSearch(event.target.value)} placeholder="ابحث باسم الحملة أو الحساب…" aria-label="البحث في الحملات"/>
        <select value={sourceFilter} onChange={event=>setSourceFilter(event.target.value)} aria-label="تصفية حسب المنصة">
          <option value="all">كل المنصات</option>
          {providers.map(provider=><option key={provider.providerKey} value={provider.providerKey}>{provider.nameAr}</option>)}
        </select>
        <select value={sortKey} onChange={event=>setSortKey(event.target.value)} aria-label="ترتيب الحملات">
          <option value="spend">الأعلى إنفاقًا</option><option value="revenue">الأعلى إيرادًا</option>
          <option value="roas">الأعلى ROAS</option><option value="leads">الأكثر نتائج</option>
        </select>
      </div>
      <CampaignTable rows={campaigns} currency={currency}/>
    </section>

    {modal==='provider'&&selected&&<ProviderModal
      provider={selected}
      busy={busy}
      error={error}
      onSave={saveProvider}
      onClose={()=>!busy&&(setModal(''),setSelectedKey(null))}
    />}
    {modal==='settings'&&<SettingsModal
      settings={initialData?.settings||{}}
      busy={busy}
      error={error}
      onSave={saveSettings}
      onClose={()=>!busy&&setModal('')}
    />}
  </section>;
}


function PlatformAnalytics({analyses,selectedKey,onSelect,currency,summary}){
  const selected=analyses.find(item=>item.providerKey===selectedKey)||null;
  return <section className={[styles.section,styles.analyticsSection].join(' ')} aria-labelledby="platform-analysis-title">
    <SectionHead eyebrow="تحليل متعدد المنصات" title="تحليل مستقل لكل منصة وقراءة شاملة للجميع" note="كل رقم من بيانات المنصة الرسمية، والعملاء من CRM، والمبيعات الموثقة من المتجر."/>
    <div className={styles.analysisTabs} role="tablist" aria-label="نطاق تحليل الحملات">
      <button type="button" role="tab" aria-selected={selectedKey==='all'} className={selectedKey==='all'?styles.analysisTabActive:''} onClick={()=>onSelect('all')}>التحليل الشامل</button>
      {analyses.map(item=>{const meta=providerMeta(item.providerKey);return <button type="button" role="tab" aria-selected={selectedKey===item.providerKey} className={selectedKey===item.providerKey?styles.analysisTabActive:''} onClick={()=>onSelect(item.providerKey)} key={item.providerKey}><span className={[styles.analysisTabMark,styles[meta.className]].join(' ')}>{meta.short}</span>{item.nameAr}<i className={item.hasData?styles.tabHasData:''}/></button>;})}
    </div>
    {selectedKey==='all'
      ?<PortfolioAnalysis analyses={analyses} currency={currency} summary={summary}/>
      :<SinglePlatformAnalysis analysis={selected} currency={currency}/>}
  </section>;
}

function PortfolioAnalysis({analyses,currency,summary}){
  const rows=analyses.filter(item=>item.hasData);
  const totalSpend=Number(summary?.spendMinor)||sumMetric(rows,'spendMinor');
  const totalPlatformRevenue=Number(summary?.platformRevenueMinor)
    ||sumMetric(rows,'platformRevenueMinor');
  const totalPlatformLeads=Number(summary?.platformLeads)
    ||sumMetric(rows,'platformLeads');
  const totalVerifiedRevenue=Number(summary?.revenueMinor)
    ||sumMetric(rows,'revenueMinor');
  const byPlatformRoas=rows.filter(item=>item.spendMinor>0).slice()
    .sort((a,b)=>(Number(b.platformRoas)||0)-(Number(a.platformRoas)||0));
  const byPlatformLeads=rows.slice()
    .sort((a,b)=>b.platformLeads-a.platformLeads);
  const byVerifiedRevenue=rows.slice()
    .sort((a,b)=>b.revenueMinor-a.revenueMinor);
  const risk=rows.find(item=>item.spendMinor>0
    &&item.platformLeads===0&&item.platformConversions===0);
  const headline=!rows.length
    ?'اربط أول منصة وابدأ المزامنة'
    :risk
      ?'ابدأ بمراجعة '+risk.nameAr+' قبل زيادة الميزانية'
      :'أفضل عائد معلن حاليًا من '+(byPlatformRoas[0]?.nameAr||'المنصات المتصلة');
  const detail=!rows.length
    ?'ستظهر هنا مقارنة عادلة بعد توحيد العملة ونموذج الإسناد.'
    :number(rows.length,0)+' منصة بها بيانات فعلية، و'
      +number(totalPlatformLeads,0)+' نتيجة أبلغت بها المنصات، مقابل '
      +money(totalVerifiedRevenue,currency)+' إيراد موثق داخل ماركتون.';
  return <div className={styles.analysisBody}>
    <div className={styles.portfolioHeadline}><div><span>الخلاصة التنفيذية</span><h4>{headline}</h4><p>{detail}</p></div><strong>{ratio(summary?.platformRoas)}</strong></div>
    <div className={styles.leaderGrid}>
      <AnalysisLeader label="الأعلى ROAS حسب المنصة" analysis={byPlatformRoas[0]} value={ratio(byPlatformRoas[0]?.platformRoas)}/>
      <AnalysisLeader label="الأكثر نتائج معلنة" analysis={byPlatformLeads[0]} value={byPlatformLeads[0]?number(byPlatformLeads[0].platformLeads,0):'—'}/>
      <AnalysisLeader label="الأعلى إيرادًا موثقًا" analysis={byVerifiedRevenue[0]} value={byVerifiedRevenue[0]?money(byVerifiedRevenue[0].revenueMinor,currency):'—'}/>
    </div>
    <div className={styles.portfolioGrid}>
      <article className={styles.sharePanel}><header><span>توزيع الميزانية وعائد المنصات</span><h4>منصة بمنصة</h4></header><div className={styles.shareList}>
        {rows.map(item=>{const meta=providerMeta(item.providerKey);const spendShare=totalSpend>0?100*item.spendMinor/totalSpend:0;const revenueShare=totalPlatformRevenue>0?100*item.platformRevenueMinor/totalPlatformRevenue:0;return <div key={item.providerKey}><header><span className={[styles.sourceMark,styles[meta.className]].join(' ')}>{meta.short}</span><b>{item.nameAr}</b><small>{number(spendShare,1)}٪ من الميزانية</small></header><section><i style={{width:String(Math.max(2,spendShare))+'%'}}/><em style={{width:String(Math.max(2,revenueShare))+'%'}}/></section><footer><span>إنفاق {money(item.spendMinor,currency)}</span><span>عائد منصة {money(item.platformRevenueMinor,currency)}</span></footer></div>;})}
        {!rows.length&&<Empty text="لا توجد بيانات منصات للمقارنة في الفترة الحالية."/>}
      </div></article>
      <article className={styles.portfolioTablePanel}><header><span>جدول القرار الموحّد</span><h4>المعلن من المنصة مقابل الموثق داخليًا</h4></header><div className={styles.analysisTableWrap}><table><thead><tr><th>المنصة</th><th>الإنفاق</th><th>نتائج المنصة</th><th>CRM موثق</th><th>مبيعات</th><th>ROAS المنصة</th><th>ROAS الموثق</th><th>القرار</th></tr></thead><tbody>
        {rows.map(item=>{const verdict=analysisDecision(item);return <tr key={item.providerKey}><td><b>{item.nameAr}</b><small>{item.channel}</small></td><td>{money(item.spendMinor,currency)}</td><td>{number(item.platformLeads,0)}</td><td>{number(item.leads,0)}</td><td>{number(item.sales,0)}</td><td><strong>{ratio(item.platformRoas)}</strong></td><td>{ratio(item.roas)}</td><td><i className={styles['decision_'+verdict.tone]}>{verdict.label}</i></td></tr>;})}
        {!rows.length&&<tr><td colSpan="8"><Empty text="ستظهر المقارنة بعد أول مزامنة ناجحة."/></td></tr>}
      </tbody></table></div></article>
    </div>
  </div>;
}

function AnalysisLeader({label,analysis,value}){
  const meta=analysis?providerMeta(analysis.providerKey):providerMeta('');
  return <article className={styles.leaderCard}><span className={[styles.sourceMark,styles[meta.className]].join(' ')}>{analysis?meta.short:'—'}</span><div><small>{label}</small><b>{analysis?.nameAr||'لا توجد بيانات'}</b></div><strong>{value}</strong></article>;
}

function SinglePlatformAnalysis({analysis,currency}){
  if(!analysis)return <Empty text="اختر منصة لعرض تحليلها."/>;
  const meta=providerMeta(analysis.providerKey);
  const decision=analysisDecision(analysis);
  if(!analysis.hasData)return <div className={styles.platformEmpty}><span className={[styles.providerMark,styles[meta.className]].join(' ')}>{meta.short}</span><div><h4>{analysis.nameAr}</h4><p>{decision.text}</p><small>{analysis.connection?'الاتصال محفوظ؛ اختبره ثم شغّل المزامنة.':'المنصة غير مربوطة حتى الآن.'}</small></div></div>;
  const cards=[
    ['الإنفاق',money(analysis.spendMinor,currency)],
    ['نتائج المنصة',number(analysis.platformLeads,0)],
    ['تحويلات المنصة',number(analysis.platformConversions,0)],
    ['ROAS حسب المنصة',ratio(analysis.platformRoas)],
    ['عملاء CRM موثقون',number(analysis.leads,0)],
    ['مبيعات موثقة',number(analysis.sales,0)],
    ['إيراد موثق',money(analysis.revenueMinor,currency)],
    ['ROAS موثق',ratio(analysis.roas)]
  ];
  return <div className={styles.analysisBody}>
    <div className={styles.platformHeadline}><div className={styles.platformIdentity}><span className={[styles.providerMark,styles[meta.className]].join(' ')}>{meta.short}</span><div><small>تحليل منصة مستقل</small><h4>{analysis.nameAr}</h4><p>{analysis.channel}</p></div></div><div className={[styles.platformDecision,styles['decisionBox_'+decision.tone]].join(' ')}><span>{decision.label}</span><p>{decision.text}</p></div></div>
    <div className={styles.platformMetrics}>{cards.map(([label,value])=><article key={label}><span>{label}</span><b>{value}</b></article>)}</div>
    <div className={styles.efficiencyStrip}>
      <div><span>مرات الظهور</span><b>{number(analysis.impressions,0)}</b></div><div><span>النقرات</span><b>{number(analysis.clicks,0)}</b></div>
      <div><span>CTR</span><b>{percent(analysis.ctr)}</b></div><div><span>CPC</span><b>{analysis.cpcMinor==null?'—':money(analysis.cpcMinor,currency)}</b></div>
      <div><span>CPL حسب المنصة</span><b>{analysis.platformCplMinor==null?'—':money(analysis.platformCplMinor,currency)}</b></div>
      <div><span>تكلفة تحويل المنصة</span><b>{analysis.platformCostPerConversionMinor==null?'—':money(analysis.platformCostPerConversionMinor,currency)}</b></div>
      <div><span>تأهيل CRM</span><b>{percent(analysis.qualificationRate)}</b></div><div><span>ثقة الإسناد</span><b>{percent(analysis.confidenceScore)}</b></div>
    </div>
    <div className={styles.campaignVerdicts}>
      <CampaignVerdict title="أفضل حملة" campaign={analysis.topCampaign} currency={currency} tone="best"/>
      <CampaignVerdict title="الحملة الأَولى بالمراجعة" campaign={analysis.weakCampaign} currency={currency} tone="review"/>
      <article className={styles.platformInsights}><header><span>تنبيهات {analysis.nameAr}</span><b>{number(analysis.insights.length,0)}</b></header>{analysis.insights.slice(0,3).map(item=><div key={item.id}><b>{item.title}</b><p>{item.recommendedAction}</p></div>)}{!analysis.insights.length&&<p>لا توجد تنبيهات مفتوحة خاصة بهذه المنصة.</p>}</article>
    </div>
    <div className={styles.platformCampaigns}><header><span>تفصيل الحملات</span><h4>كل حملات {analysis.nameAr} في الفترة</h4></header><CampaignTable rows={analysis.campaigns} currency={currency}/></div>
  </div>;
}

function CampaignVerdict({title,campaign,currency,tone}){
  const value=campaign?.platformRoas??campaign?.roas;
  return <article className={[styles.campaignVerdict,styles['verdict_'+tone]].join(' ')}><span>{title}</span>{campaign?<><h4>{campaign.name}</h4><div><b>{ratio(value)}</b><small>{money(campaign.spendMinor,currency)} إنفاق · {number(campaign.platformLeads,0)} نتائج منصة · {number(campaign.sales,0)} مبيعات موثقة</small></div></>:<p>لا توجد بيانات كافية للحكم.</p>}</article>;
}

function SectionHead({eyebrow,title,note}){
  return <header className={styles.sectionHead}><div><span>{eyebrow}</span><h3>{title}</h3></div><p>{note}</p></header>;
}

const DataHealth=memo(function DataHealth({
  data,activeConnections,connectedCount,commerceSources
}){
  const items=[
    ['الاتصالات النشطة',activeConnections,`${connectedCount} محفوظة`],
    ['تحتاج متابعة',data.connectionsNeedingAttention||0,'رمز أو صلاحية'],
    ['مصادر التجارة',commerceSources.length,'متجر/منصة متصلة'],
    ['اختلاف العملات',data.currencyMismatches||0,'مستبعدة من ROAS الإجمالي'],
    ['آخر مزامنة',dateTime(data.lastSyncedAt),'حالة حداثة البيانات']
  ];
  return <div className={styles.health}>
    <div className={styles.healthTitle}><i/><span><b>سلامة البيانات</b><small>قبل اتخاذ قرار الميزانية</small></span></div>
    {items.map(([label,value,note])=><div key={label}><span>{label}</span><b>{typeof value==='number'?number(value,0):value}</b><small>{note}</small></div>)}
  </div>;
});

function ProviderCard({provider,canManage,busy,onOpen,onTest,onSync,onToggle}){
  const meta=providerMeta(provider.providerKey);
  const connection=provider.connection;
  const status=connection?.status||'not_connected';
  const canSync=['active','degraded'].includes(status);
  const running=Boolean(busy);
  const recentRun=connection?.recentRuns?.[0];
  return <article className={styles.providerCard}>
    <header><span className={`${styles.providerMark} ${styles[meta.className]}`}>{meta.short}</span><div><b>{provider.nameAr}</b><small>{meta.channel}</small></div><i className={`${styles.status} ${styles[`status_${status}`]}`}>{STATUS_LABELS[status]||'غير متصل'}</i></header>
    <p>{provider.descriptionAr}</p>
    <dl>
      <div><dt>الحساب</dt><dd>{connection?.accounts?.[0]?.name||connection?.displayName||'—'}</dd></div>
      <div><dt>آخر مزامنة</dt><dd>{dateTime(connection?.lastSyncedAt)}</dd></div>
      <div><dt>الجدولة</dt><dd>{scheduleLabel(connection)}</dd></div>
      <div><dt>آخر تشغيل</dt><dd>{RUN_LABELS[recentRun?.status]||'—'}</dd></div>
      <div><dt>المزامنة القادمة</dt><dd>{dateTime(connection?.nextSyncAt)}</dd></div>
    </dl>
    <footer>
      {!connection&&<button disabled={!canManage||running} onClick={onOpen}>ربط الحساب</button>}
      {connection&&<>
        <button disabled={!canManage||running||!canSync} title={!canSync?'اختبر الاتصال أولًا':undefined} onClick={onSync}>مزامنة الآن</button>
        <button className={styles.secondary} disabled={!canManage||running} onClick={onTest}>اختبار</button>
        <button className={styles.textButton} disabled={!canManage||running} onClick={onOpen}>الإعدادات</button>
        <button className={styles.textButton} disabled={!canManage||running} onClick={onToggle}>{status==='disabled'?'تفعيل':'إيقاف'}</button>
      </>}
    </footer>
  </article>;
}

const PerformanceChart=memo(function PerformanceChart({rows,currency}){
  const data=chartBuckets(rows);
  const max=Math.max(1,...data.flatMap(row=>[Number(row.spendMinor)||0,Number(row.revenueMinor)||0]));
  return <article className={`${styles.panel} ${styles.chartPanel}`}>
    <header><div><span>اتجاه الأداء</span><h3>الإنفاق مقابل الإيراد المنسوب</h3></div><div className={styles.legend}><span><i className={styles.spendDot}/>إنفاق</span><span><i className={styles.revenueDot}/>إيراد</span></div></header>
    <div className={styles.chart}>
      {data.map(row=><div className={styles.chartColumn} key={`${row.date}-${row.endDate||''}`} title={`إنفاق ${money(row.spendMinor,currency)} — إيراد ${money(row.revenueMinor,currency)}`}>
        <div><i className={styles.spendBar} style={{height:`${Math.max(2,(Number(row.spendMinor)||0)/max*100)}%`}}/><i className={styles.revenueBar} style={{height:`${Math.max(2,(Number(row.revenueMinor)||0)/max*100)}%`}}/></div>
        <small>{shortDate(row.date)}</small>
      </div>)}
      {!data.length&&<Empty text="ستظهر حركة الإنفاق والإيراد بعد أول مزامنة."/>}
    </div>
  </article>;
});

function DecisionPanel({insights,busy,canManage,onResolve}){
  return <article className={`${styles.panel} ${styles.insightsPanel}`}>
    <header><div><span>قرارات مقترحة</span><h3>ما الذي يحتاج انتباهك الآن؟</h3></div><b>{number(insights.length,0)}</b></header>
    <div className={styles.insightList}>
      {insights.slice(0,5).map(insight=><section key={insight.id} className={styles[`severity_${insight.severity}`]||''}>
        <div><i/><span><b>{insight.title}</b><small>{insight.detail}</small></span></div>
        <p>{insight.recommendedAction}</p>
        {canManage&&<footer><button disabled={Boolean(busy)} onClick={()=>onResolve(insight,'resolved')}>تم التنفيذ</button><button disabled={Boolean(busy)} onClick={()=>onResolve(insight,'dismissed')}>إخفاء</button></footer>}
      </section>)}
      {!insights.length&&<Empty text="لا توجد تنبيهات حرجة. ستظهر توصيات قابلة للتنفيذ بعد تراكم بيانات كافية."/>}
    </div>
  </article>;
}

const SourcePerformance=memo(function SourcePerformance({sources,currency}){
  const max=Math.max(1,...sources.map(item=>Number(item.spendMinor)||0));
  return <article className={styles.smallPanel}><header><span>مقارنة القنوات</span><h3>المعلن من المنصة مقابل الموثق</h3></header><div className={styles.sourceList}>
    {sources.map(source=>{const meta=providerMeta(source.providerKey);return <div key={source.providerKey}><span className={`${styles.sourceMark} ${styles[meta.className]}`}>{meta.short}</span><section><header><b>{meta.channel}</b><strong>{ratio(source.platformRoas)}</strong></header><i><em style={{width:`${Math.max(3,(Number(source.spendMinor)||0)/max*100)}%`}}/></i><small>{money(source.spendMinor,currency)} إنفاق · {number(source.platformLeads,0)} نتائج منصة · {money(source.revenueMinor,currency)} إيراد موثق</small></section></div>;})}
    {!sources.length&&<Empty text="لا توجد قناة ذات إنفاق في الفترة."/>}
  </div></article>;
});

const Funnel=memo(function Funnel({rows}){
  const max=Math.max(1,...rows.map(row=>Number(row.count)||0));
  return <article className={styles.smallPanel}><header><span>رحلة العميل</span><h3>من العميل إلى البيع</h3></header><div className={styles.funnel}>
    {rows.map((row,index)=><div key={row.key} style={{width:`${Math.max(38,(Number(row.count)||0)/max*100)}%`}}><span>{index+1}</span><b>{row.label}</b><strong>{number(row.count,0)}</strong></div>)}
    {!rows.length&&<Empty text="سيظهر مسار التحويل بعد تسجيل العملاء."/>}
  </div></article>;
});

const CommerceSources=memo(function CommerceSources({rows}){
  return <article className={styles.smallPanel}><header><span>مصدر الحقيقة</span><h3>المتاجر والإيراد</h3></header><div className={styles.storeList}>
    {rows.map(row=><div key={`${row.providerKey}-${row.nameAr}`}><i className={['active','degraded'].includes(row.status)?styles.storeActive:''}/><span><b>{row.nameAr}</b><small>{number(row.orderCount,0)} طلب · {dateTime(row.lastSyncedAt)}</small></span></div>)}
    {!rows.length&&<Empty text="اربط سلة أو زد أو Shopify أو WooCommerce لإسناد المبيعات الفعلية."/>}
  </div></article>;
});

function CampaignTable({rows,currency}){
  return <div className={styles.tableWrap}><table><thead><tr><th>الحملة</th><th>الحالة</th><th>الإنفاق</th><th>نتائج المنصة</th><th>تحويلات المنصة</th><th>CRM موثق</th><th>مبيعات موثقة</th><th>ROAS المنصة</th><th>ROAS الموثق</th><th>الثقة</th></tr></thead><tbody>
    {rows.map(row=>{const meta=providerMeta(row.providerKey);return <tr key={row.id}>
      <td><div className={styles.campaignName}><span className={`${styles.sourceMark} ${styles[meta.className]}`}>{meta.short}</span><span><b>{row.name}</b><small>{row.accountName}</small></span></div></td>
      <td><i className={`${styles.campaignStatus} ${['active','enabled'].includes(row.status)?styles.campaignActive:''}`}>{row.status||'unknown'}</i></td>
      <td>{money(row.spendMinor,row.currency||currency)}</td>
      <td>{number(row.platformLeads,0)}</td><td>{number(row.platformConversions,0)}</td>
      <td>{number(row.leads,0)}</td><td>{number(row.sales,0)}</td>
      <td><strong>{ratio(row.platformRoas)}</strong></td>
      <td><strong className={(Number(row.roas)||0)>=2?styles.goodRoas:(Number(row.roas)||0)<1?styles.badRoas:''}>{ratio(row.roas)}</strong></td>
      <td>{row.confidenceScore==null?'—':`${number(row.confidenceScore,0)}٪`}</td>
    </tr>;})}
    {!rows.length&&<tr><td colSpan="10"><Empty text="لا توجد حملات مطابقة للفترة أو البحث الحالي."/></td></tr>}
  </tbody></table></div>;
}

function Empty({text}){return <div className={styles.empty}><span>◇</span><p>{text}</p></div>;}

function ProviderModal({provider,busy,error,onSave,onClose}){
  const connection=provider.connection||{};
  const configured=new Set(connection.configuredSecrets||[]);
  const config=connection.configuration||{};
  const fields=[...(provider.requiredConfigKeys||[]),...(provider.optionalConfigKeys||[])];
  const secrets=[...(provider.requiredSecretKeys||[]),...(provider.optionalSecretKeys||[])];
  const meta=providerMeta(provider.providerKey);
  return <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="provider-modal-title">
    <button className={styles.backdrop} onClick={onClose} aria-label="إغلاق"/>
    <form className={styles.modal} onSubmit={onSave}>
      <header><div className={styles.modalIdentity}><span className={`${styles.providerMark} ${styles[meta.className]}`}>{meta.short}</span><div><small>اتصال رسمي للقراءة والتحليل</small><h3 id="provider-modal-title">ربط {provider.nameAr}</h3><p>لن ننشئ أو نوقف حملات من هذا الاتصال. الرموز تُحفظ مشفّرة ولا تعود للمتصفح.</p></div></div><button type="button" onClick={onClose}>×</button></header>
      <div className={styles.modalBody}>
        <div className={styles.securityNote}><b>نطاق آمن</b><span>استخدم أقل صلاحيات قراءة مطلوبة للحساب والتقارير. يُفضّل OAuth وRefresh Token عند توفرهما.</span></div>
        <div className={styles.formGrid}>
          <label><span>اسم الاتصال</span><input name="displayName" defaultValue={connection.displayName||provider.nameAr} required/></label>
          <label><span>إصدار API</span><select name="apiVersion" defaultValue={connection.apiVersion||provider.apiVersion}>{(provider.supportedApiVersions||[provider.apiVersion]).map(version=><option key={version}>{version}</option>)}</select></label>
          {fields.map(key=><label key={key}><span>{FIELD_LABELS[key]||key}{(provider.requiredConfigKeys||[]).includes(key)?' *':''}</span><input name={key} defaultValue={config[key]||''} required={(provider.requiredConfigKeys||[]).includes(key)}/></label>)}
          {secrets.map(key=><label key={key}><span>{FIELD_LABELS[key]||key}{(provider.requiredSecretKeys||[]).includes(key)?' *':''}</span><input name={key} type={SECRET_FIELDS.has(key)?'password':'text'} placeholder={configured.has(key)?'محفوظ مشفّرًا — اتركه فارغًا للإبقاء عليه':''} required={(provider.requiredSecretKeys||[]).includes(key)&&!configured.has(key)} autoComplete="new-password"/></label>)}
          <label><span>جدول المزامنة</span><select name="frequency" defaultValue={connection.frequency||'daily'}><option value="manual">يدوي</option><option value="every_6_hours">كل 6 ساعات</option><option value="daily">يومي</option></select></label>
          <label><span>موعد المزامنة بتوقيت السعودية</span><input name="syncTime" type="time" step="300" defaultValue={connection.syncTime||'03:00'} required/></label>
          <label><span>إعادة قراءة الأيام الأخيرة</span><input type="number" name="syncLookbackDays" min="1" max="90" defaultValue={connection.syncLookbackDays||14}/></label>
        </div>
        {provider.providerKey==='google_ads'&&<p className={styles.providerHint}>Google يحتاج Developer Token، ومعه Access Token مباشر أو المجموعة الكاملة: Refresh Token + Client ID + Client Secret.</p>}
        <a className={styles.docsLink} href={provider.documentationUrl} target="_blank" rel="noreferrer">فتح التوثيق الرسمي للمنصة ↗</a>
        {error&&<div className={styles.error}>{error}</div>}
      </div>
      <footer><button type="button" className={styles.cancelButton} onClick={onClose} disabled={Boolean(busy)}>إلغاء</button><button type="submit" disabled={Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ الاتصال بأمان'}</button></footer>
    </form>
  </div>;
}

function SettingsModal({settings,busy,error,onSave,onClose}){
  return <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
    <button className={styles.backdrop} onClick={onClose} aria-label="إغلاق"/>
    <form className={`${styles.modal} ${styles.settingsModal}`} onSubmit={onSave}>
      <header><div><small>سياسة القياس الموحدة</small><h3 id="settings-modal-title">إعدادات الإسناد وROAS</h3><p>هذه السياسة تحدد كيف يحصل كل تفاعل على نصيبه من العميل والإيراد.</p></div><button type="button" onClick={onClose}>×</button></header>
      <div className={styles.modalBody}><div className={styles.formGrid}>
        <label><span>نموذج الإسناد</span><select name="model" defaultValue={settings.model||'last_non_direct'}>{Object.entries(MODEL_LABELS).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
        <label><span>عملة القرار</span><input name="baseCurrency" maxLength="3" pattern="[A-Za-z]{3}" defaultValue={settings.baseCurrency||'SAR'} required/></label>
        <label><span>نافذة النقر بالأيام</span><input type="number" name="clickWindowDays" min="1" max="180" defaultValue={settings.clickWindowDays||30}/></label>
        <label><span>نافذة المشاهدة بالأيام</span><input type="number" name="viewWindowDays" min="0" max="30" defaultValue={settings.viewWindowDays??1}/></label>
        <label className={styles.fullField}><span>المنطقة الزمنية</span><input name="timezone" defaultValue={settings.timezone||'Asia/Riyadh'} required/></label>
      </div><div className={styles.modelNote}><b>الموصى به: آخر تفاعل غير مباشر</b><span>يحافظ على المصدر المؤثر الأخير، ولا يمنح الزيارات المباشرة اللاحقة رصيد الحملة.</span></div>{error&&<div className={styles.error}>{error}</div>}</div>
      <footer><button type="button" className={styles.cancelButton} onClick={onClose} disabled={Boolean(busy)}>إلغاء</button><button type="submit" disabled={Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ السياسة'}</button></footer>
    </form>
  </div>;
}
