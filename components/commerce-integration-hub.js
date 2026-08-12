'use client';

import Image from 'next/image';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  pollWooSyncRun,
  wooSyncReviewedCount
} from '../lib/woocommerce-sync-state.mjs';
import styles from './commerce-integration-hub.module.css';

const STATUS_LABELS={
  draft:'محفوظ ويحتاج اختبارًا',
  awaiting_authorization:'بانتظار التفويض',
  active:'متصل',
  degraded:'متصل مع ملاحظات',
  error:'يحتاج مراجعة',
  disabled:'متوقف'
};

const FREQUENCIES={
  manual:'يدوي فقط',
  daily:'يومي',
  weekly:'أسبوعي',
  monthly:'شهري'
};

const PROVIDER_LOGOS={
  woocommerce:'/integrations/woocommerce.svg',
  salla:'/integrations/salla.svg',
  zid:'/integrations/zid.svg',
  shopify:'/integrations/shopify.svg',
  custom:'/integrations/custom-api.svg'
};

const FIELD_LABELS={
  storeUrl:'رابط متجر WordPress',
  storeId:'معرّف متجر زد',
  shopDomain:'نطاق Shopify',
  baseUrl:'رابط واجهة المتجر',
  authType:'طريقة المصادقة',
  consumerKey:'Consumer Key',
  consumerSecret:'Consumer Secret',
  accessToken:'Access Token',
  authorizationToken:'Authorization Token',
  refreshToken:'Refresh Token',
  webhookSecret:'Webhook Secret',
  apiKey:'API Key',
  bearerToken:'Bearer Token',
  basicUsername:'اسم مستخدم API',
  basicPassword:'كلمة مرور API'
};

const SECRET_FIELDS=new Set([
  'consumerKey','consumerSecret','accessToken','authorizationToken',
  'refreshToken','webhookSecret','apiKey','bearerToken',
  'basicUsername','basicPassword'
]);

const SCOPE_LABELS={
  products:'الدورات والمنتجات والأسعار',
  categories:'التصنيفات',
  attributes:'السمات',
  collections:'المجموعات',
  variations:'الخيارات',
  variants:'الخيارات',
  coupons:'الكوبونات',
  discounts:'الخصومات',
  orders:'الطلبات والمدفوعات',
  customers:'العملاء',
  webhooks:'التحديث الفوري'
};

const GUIDE_STEPS={
  woocommerce:[
    ['افتح إعدادات WooCommerce','من لوحة WordPress انتقل إلى WooCommerce ← الإعدادات ← متقدم ← REST API.'],
    ['أنشئ مفتاحًا للقراءة','أنشئ مفتاحًا بصلاحية قراءة، ثم انسخ Consumer Key وConsumer Secret فورًا.'],
    ['أدخل رابط المتجر','استخدم رابط الموقع الأساسي مع HTTPS ثم احفظ الاتصال واختبره.'],
    ['ابدأ المزامنة','ابدأ بالدورات والأسعار، راجع النتائج، ثم فعّل الطلبات والعملاء.']
  ],
  salla:[
    ['جهّز صلاحية الوصول','من تطبيق ماركتون في سلة وافق على صلاحيات المنتجات والطلبات والعملاء المطلوبة.'],
    ['انسخ رمز الوصول','أدخل Access Token الصالح للمتجر. لا يظهر الرمز مرة أخرى بعد حفظه.'],
    ['اختبر المتجر','اضغط اختبار الاتصال للتأكد من هوية المتجر والصلاحيات.'],
    ['فعّل الجدولة','اختر يدوي أو يومي أو أسبوعي أو شهري ثم ابدأ أول مزامنة.']
  ],
  zid:[
    ['احصل على بيانات زد','جهّز Store ID وAuthorization Token وAccess Token من إعدادات التطبيق.'],
    ['أدخل المعرّف والرموز','الصق القيم كما هي دون مسافات إضافية.'],
    ['تحقق من الصلاحيات','اختبار الاتصال يتأكد من وصول ماركتون للمنتجات والطلبات.'],
    ['شغّل المزامنة','ابدأ بالمنتجات والأسعار ثم أضف العملاء والطلبات بعد مراجعة النتائج.']
  ],
  shopify:[
    ['أنشئ تطبيقًا مخصصًا','من Shopify Admin انتقل إلى Settings ← Apps and sales channels ← Develop apps.'],
    ['حدد الصلاحيات','فعّل صلاحيات قراءة المنتجات والعملاء والطلبات والخصومات حسب احتياجك.'],
    ['انسخ بيانات الاتصال','أدخل نطاق المتجر مثل your-store.myshopify.com ثم Access Token.'],
    ['اختبر ثم زامن','نفّذ اختبار الاتصال وبعد نجاحه شغّل المزامنة الأولى.']
  ],
  custom:[
    ['راجع عقد API','يجب أن يوفر المتجر نقاط قراءة واضحة للمنتجات والعملاء والطلبات.'],
    ['استخدم رابطًا عامًا آمنًا','أدخل HTTPS عام فقط. الروابط الداخلية والمحلية مرفوضة للحماية.'],
    ['حدد المصادقة','اختر API Key أو Bearer أو Basic Auth وأدخل البيانات المطلوبة.'],
    ['اختبر عينة صغيرة','اختبر الاتصال وابدأ بالمنتجات قبل توسيع نطاق المزامنة.']
  ]
};

const delay=milliseconds=>new Promise(resolve=>{
  window.setTimeout(resolve,milliseconds);
});

function providerScope(providerKey,scope){
  const values=[...new Set(scope||[])];
  if(
    providerKey==='woocommerce'
    &&values.includes('attributes')
    &&!values.includes('attribute_terms')
  )values.push('attribute_terms');
  return values;
}

export default function CommerceIntegrationHub({slug,initialData,canManage}){
  const router=useRouter();
  const providers=useMemo(
    ()=>(initialData?.providers||[]).slice().sort(
      (a,b)=>(a.sortOrder??100)-(b.sortOrder??100)
    ),
    [initialData]
  );
  const [selectedKey,setSelectedKey]=useState(null);
  const [modalMode,setModalMode]=useState('connect');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const syncKeys=useRef(new Map());
  const mounted=useRef(true);
  const selected=useMemo(
    ()=>providers.find(item=>item.providerKey===selectedKey)||null,
    [providers,selectedKey]
  );
  const connectedCount=providers.filter(item=>
    ['active','degraded','draft','awaiting_authorization']
      .includes(item.connection?.status)
  ).length;

  useEffect(()=>{
    mounted.current=true;
    return ()=>{mounted.current=false;};
  },[]);

  useEffect(()=>{
    if(!selected)return undefined;
    const previousOverflow=document.body.style.overflow;
    const closeOnEscape=event=>{
      if(event.key==='Escape'&&!busy)setSelectedKey(null);
    };
    document.body.style.overflow='hidden';
    window.addEventListener('keydown',closeOnEscape);
    return ()=>{
      document.body.style.overflow=previousOverflow;
      window.removeEventListener('keydown',closeOnEscape);
    };
  },[selected,busy]);

  async function call(provider,action,payload={},options={}){
    const headers={'content-type':'application/json'};
    if(options.idempotencyKey){
      headers['x-idempotency-key']=options.idempotencyKey;
    }
    const response=await fetch(`/api/commerce/${provider}/${action}`,{
      method:'POST',
      headers,
      body:JSON.stringify({tenantSlug:slug,payload})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(
      result.error||'تعذر تنفيذ عملية الربط'
    );
    return result.data||result;
  }

  function openModal(provider,mode='connect'){
    setNotice('');
    setError('');
    setSelectedKey(provider.providerKey);
    setModalMode(mode);
  }

  async function save(event){
    event.preventDefault();
    if(!selected)return;
    setBusy('save');
    setNotice('');
    setError('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      const configuration={};
      const secrets={};
      for(const key of selected.requiredConfigKeys||[]){
        configuration[key]=String(values[key]||'').trim();
      }
      for(const key of [
        ...(selected.requiredSecretKeys||[]),
        ...(selected.optionalSecretKeys||[])
      ]){
        const value=String(values[key]||'').trim();
        if(value)secrets[key]=value;
      }
      if(selected.providerKey==='custom'){
        configuration.authType=String(values.authType||'none');
      }
      const frequency=String(values.frequency||'daily');
      const syncTime=String(values.syncTime||'03:00');
      const scope=(selected.capabilities||[]).filter(key=>
        key==='products'||values[`scope_${key}`]==='on'
      );
      const normalizedScope=providerScope(selected.providerKey,scope);
      const matchBySku=values.matchBySku==='on';
      const payload=selected.providerKey==='woocommerce'
        ?{
            storeUrl:configuration.storeUrl,
            frequency,
            syncTime,
            syncTimezone:'Asia/Riyadh',
            matchBySku,
            syncScope:normalizedScope,
            secrets
          }
        :{
            displayName:String(
              values.displayName||selected.nameAr||''
            ).trim(),
            frequency,
            syncTime,
            syncTimezone:'Asia/Riyadh',
            direction:'inbound',
            sourceOfTruth:'remote',
            conflictPolicy:'remote_wins',
            matchBySku,
            syncScope:normalizedScope,
            configuration,
            secrets
          };
      await call(selected.providerKey,'save',payload);
      setSelectedKey(null);
      setNotice(
        `تم حفظ إعدادات ${selected.nameAr} بصورة آمنة. `
        +'اختبر الاتصال قبل أول مزامنة.'
      );
      router.refresh();
    }catch(reason){
      setError(reason.message);
    }finally{
      setBusy('');
    }
  }

  async function runAction(provider,action){
    setBusy(`${action}:${provider.providerKey}`);
    setNotice('');
    setError('');
    try{
      let syncKey=null;
      if(action==='sync'){
        syncKey=syncKeys.current.get(provider.providerKey)
          ||crypto.randomUUID();
        syncKeys.current.set(provider.providerKey,syncKey);
      }
      const result=await call(provider.providerKey,action,{
        scope:provider.connection?.syncScope||['products']
      },{
        idempotencyKey:syncKey
      });
      if(action==='test'){
        const identity=result?.identity
          ||result?.store
          ||result?.remoteMetadata
          ||{};
        setNotice(
          `تم اختبار ${provider.nameAr} بنجاح`
          +`${identity.name?` — ${identity.name}`:''}.`
        );
      }else{
        let completed=result;
        if(
          provider.providerKey==='woocommerce'
          &&result?.runId
          &&(result.status==='running'||result.duplicate===true)
        ){
          setNotice(
            `بدأت مزامنة ${provider.nameAr}. `
            +'يمكنك إبقاء الصفحة مفتوحة لمتابعة اكتمالها.'
          );
          completed=await waitForWooSync(result.runId);
          if(!completed){
            setNotice(
              `مزامنة ${provider.nameAr} ما زالت تعمل في الخلفية. `
              +'لن يؤدي ذلك إلى تكرار البيانات.'
            );
            router.refresh();
            return;
          }
        }
        if(completed?.status==='failed'){
          syncKeys.current.delete(provider.providerKey);
          throw new Error('فشلت مزامنة WooCommerce. راجع سجل التشغيل.');
        }
        const total=wooSyncReviewedCount(completed);
        const failed=Number(completed?.failedCount)||0;
        setNotice(completed?.status==='partial'
          ?`اكتملت مزامنة ${provider.nameAr} مع تحذيرات: `
            +`${total.toLocaleString('ar-SA')} سجلًا، `
            +`${failed.toLocaleString('ar-SA')} تعذر حفظه.`
          :`اكتملت مزامنة ${provider.nameAr}: `
            +`${total.toLocaleString('ar-SA')} سجلًا.`
        );
        syncKeys.current.delete(provider.providerKey);
      }
      router.refresh();
    }catch(reason){
      setError(reason.message);
    }finally{
      setBusy('');
    }
  }

  async function waitForWooSync(runId){
    return pollWooSyncRun({
      runId,
      wait:delay,
      isActive:()=>mounted.current,
      fetchSnapshot:()=>call('woocommerce','status')
    });
  }

  async function toggle(provider){
    const disabled=provider.connection?.status==='disabled';
    if(disabled&&provider.providerKey==='woocommerce'){
      openModal(provider,'connect');
      return;
    }
    const action=disabled?'enable':'disable';
    const verb=disabled?'إعادة تفعيل':'إيقاف';
    if(!disabled&&!window.confirm(
      `هل تريد إيقاف ربط ${provider.nameAr}؟ `
      +'ستظل البيانات والمفاتيح المشفّرة محفوظة.'
    ))return;
    setBusy(`${action}:${provider.providerKey}`);
    setNotice('');
    setError('');
    try{
      await call(provider.providerKey,action,{});
      setNotice(`تم ${verb} ربط ${provider.nameAr}.`);
      router.refresh();
    }catch(reason){
      setError(reason.message);
    }finally{
      setBusy('');
    }
  }

  return <section className={styles.hub} aria-labelledby="commerce-hub-title">
    <header className={styles.header}>
      <div>
        <small>MARKTONE SYNC & CONNECT</small>
        <h3 id="commerce-hub-title">المزامنة والترابط</h3>
        <p>
          اربط متجر المنشأة مع ماركتون، وانقل الدورات والأسعار والعروض
          والعملاء والطلبات إلى تشغيل موحّد وآمن.
        </p>
      </div>
      <div className={styles.summary}>
        <b>{connectedCount.toLocaleString('ar-SA')}</b>
        <span>روابط محفوظة</span>
      </div>
    </header>

    <div className={styles.guardrail}>
      <span className={styles.guardIcon}>✓</span>
      <div>
        <b>ربط آمن واتجاه واضح</b>
        <span>
          المرحلة الحالية تعمل من المتجر إلى ماركتون، مع تشفير المفاتيح
          ومنع التكرار وحفظ سجل كل مزامنة.
        </span>
      </div>
    </div>

    {initialData?.degraded&&<div className={styles.degradedNotice}>
      <b>واجهة الربط جاهزة</b>
      <span>
        تعذر تحميل حالة الاتصالات الحالية مؤقتًا. يمكنك فتح دليل كل متجر
        وتجهيز بيانات الربط، وسيتم تحديث الحالة تلقائيًا بعد عودة الخدمة.
      </span>
    </div>}

    <div className={styles.grid}>
      {providers.map(provider=><ProviderCard
        key={provider.providerKey}
        provider={provider}
        canManage={canManage}
        busy={busy}
        onOpen={()=>openModal(provider,'connect')}
        onGuide={()=>openModal(provider,'guide')}
        onToggle={()=>toggle(provider)}
        onTest={()=>runAction(provider,'test')}
        onSync={()=>runAction(provider,'sync')}
      />)}
    </div>

    {!providers.length&&<div className={styles.emptyState}>
      لم يتم تحميل منصات المتاجر. أعد فتح الصفحة أو تواصل مع إدارة المنصة.
    </div>}

    {notice&&<div className={styles.notice}>{notice}</div>}
    {error&&!selected&&<div className={styles.error}>{error}</div>}

    {selected&&modalMode==='connect'&&<ProviderModal
      provider={selected}
      busy={busy}
      error={error}
      onClose={()=>!busy&&setSelectedKey(null)}
      onGuide={()=>setModalMode('guide')}
      onSave={save}
    />}
    {selected&&modalMode==='guide'&&<GuideModal
      provider={selected}
      onClose={()=>setSelectedKey(null)}
      onConnect={()=>setModalMode('connect')}
    />}
  </section>;
}

function ProviderCard({
  provider,
  canManage,
  busy,
  onOpen,
  onGuide,
  onToggle,
  onTest,
  onSync
}){
  const connection=provider.connection;
  const featureEnabled=provider.featureEnabled!==false;
  const state=connection?.status||'unconfigured';
  const isDisabled=connection?.status==='disabled';
  const canRun=connection&&canManage&&!isDisabled;
  return <article className={`${styles.card} ${styles[state]||''}`}>
    <div className={styles.cardTop}>
      <ProviderLogo
        providerKey={provider.providerKey}
        name={provider.nameAr}
      />
      <span className={`${styles.state} ${styles[`state_${state}`]||''}`}>
        {connection?STATUS_LABELS[state]||state:'غير مربوط'}
      </span>
    </div>
    <div className={styles.cardBody}>
      <h4>{provider.nameAr}</h4>
      <p>{provider.descriptionAr}</p>
      <div className={styles.tags}>
        <span>مزامنة آمنة</span>
        <span>{FREQUENCIES[
          connection?.frequency||connection?.syncFrequency
        ]||'جدولة مرنة'}</span>
      </div>
      {connection&&<dl className={styles.meta}>
        <div>
          <dt>النطاق</dt>
          <dd>{(connection.syncScope||[]).length} عناصر</dd>
        </div>
        <div>
          <dt>آخر مزامنة</dt>
          <dd>{dateLabel(connection.lastSyncedAt)}</dd>
        </div>
        <div>
          <dt>موعد التشغيل</dt>
          <dd>
            {connection.frequency==='manual'
              ?'يدوي فقط'
              :`${syncTimeLabel(connection.syncTime||'03:00')} · السعودية`}
          </dd>
        </div>
        <div>
          <dt>المزامنة القادمة</dt>
          <dd>{dateTimeLabel(connection.nextSyncAt)}</dd>
        </div>
      </dl>}
    </div>
    <footer className={styles.cardFooter}>
      <button
        type="button"
        className={styles.primaryButton}
        disabled={!canManage||!featureEnabled||Boolean(busy)}
        onClick={onOpen}
      >
        {!featureEnabled
          ?'الإضافة غير مفعلة'
          :connection?'إدارة الربط':'ربط الآن'}
      </button>
      <button
        type="button"
        className={styles.infoButton}
        onClick={onGuide}
      >مزيد من المعلومات</button>
      {canRun&&<button
        type="button"
        className={styles.secondaryButton}
        disabled={Boolean(busy)}
        onClick={onTest}
      >
        {busy===`test:${provider.providerKey}`
          ?'جارٍ الاختبار…'
          :'اختبار الاتصال'}
      </button>}
      {canRun&&['active','degraded'].includes(connection.status)&&<button
        type="button"
        className={styles.secondaryButton}
        disabled={Boolean(busy)}
        onClick={onSync}
      >
        {busy===`sync:${provider.providerKey}`
          ?'جارٍ المزامنة…'
          :'مزامنة الآن'}
      </button>}
      {connection&&canManage&&<button
        type="button"
        className={styles.linkButton}
        disabled={Boolean(busy)}
        onClick={onToggle}
      >
        {isDisabled
          ?provider.providerKey==='woocommerce'?'إعادة الربط':'إعادة التفعيل'
          :'إيقاف'}
      </button>}
    </footer>
  </article>;
}

function ProviderLogo({providerKey,name}){
  const source=PROVIDER_LOGOS[providerKey]||PROVIDER_LOGOS.custom;
  return <div className={`${styles.logoBox} ${styles[providerKey]||''}`}>
    <Image
      src={source}
      width={118}
      height={58}
      alt={`شعار ${name}`}
      className={styles.logoImage}
    />
  </div>;
}

function GuideModal({provider,onClose,onConnect}){
  const steps=GUIDE_STEPS[provider.providerKey]||GUIDE_STEPS.custom;
  return <div className={styles.modalLayer}>
    <button className={styles.backdrop} aria-label="إغلاق" onClick={onClose}/>
    <div
      className={`${styles.modal} ${styles.guideModal}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-guide-title"
    >
      <header>
        <div className={styles.guideHeading}>
          <ProviderLogo
            providerKey={provider.providerKey}
            name={provider.nameAr}
          />
          <div>
            <small>الدليل الإرشادي الذكي</small>
            <h3 id="integration-guide-title">كيف تربط {provider.nameAr}؟</h3>
            <p>
              اتبع الخطوات بالترتيب. يمكنك الرجوع للدليل في أي وقت دون
              التأثير على إعداداتك.
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="إغلاق">×</button>
      </header>
      <div className={styles.guideBody}>
        {steps.map(([title,description],index)=><div
          className={styles.guideStep}
          key={title}
        >
          <span>{(index+1).toLocaleString('ar-SA')}</span>
          <div><h4>{title}</h4><p>{description}</p></div>
        </div>)}
        <div className={styles.smartTip}>
          <b>نصيحة ماركتون</b>
          <span>
            ابدأ بمزامنة المنتجات والأسعار فقط، راجع النتائج، ثم فعّل
            العملاء والطلبات. بهذه الطريقة يكون الانتقال آمنًا وسهل المراجعة.
          </span>
        </div>
      </div>
      <footer>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onClose}
        >إغلاق</button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onConnect}
        >
          {provider.connection?'إدارة الربط':'ابدأ الربط الآن'}
        </button>
      </footer>
    </div>
  </div>;
}

function ProviderModal({provider,busy,error,onClose,onGuide,onSave}){
  const connection=provider.connection||{};
  const configuration=connection.configuration||{};
  const configuredSecrets=new Set(connection.configuredSecrets||[]);
  const capabilities=(provider.capabilities||[]).filter(
    key=>key!=='webhooks'
  );
  const frequency=connection.frequency
    ||connection.syncFrequency
    ||'daily';
  return <div className={styles.modalLayer}>
    <button className={styles.backdrop} aria-label="إغلاق" onClick={onClose}/>
    <form
      className={styles.modal}
      onSubmit={onSave}
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-connect-title"
    >
      <header>
        <div className={styles.connectHeading}>
          <ProviderLogo
            providerKey={provider.providerKey}
            name={provider.nameAr}
          />
          <div>
            <small>{provider.nameEn} CONNECTOR</small>
            <h3 id="integration-connect-title">
              {connection.connectionId||connection.id?'إدارة':'ربط'} {provider.nameAr}
            </h3>
            <p>
              أدخل معلومات الربط، ثم اختبر الاتصال قبل بدء المزامنة الأولى.
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="إغلاق">×</button>
      </header>
      <div className={styles.modalBody}>
        <button
          type="button"
          className={styles.guideLink}
          onClick={onGuide}
        >فتح الدليل الإرشادي خطوة بخطوة ←</button>
        <div className={styles.formGrid}>
          {provider.providerKey!=='woocommerce'&&<label className={styles.field}>
            اسم الربط داخل ماركتون
            <input
              name="displayName"
              defaultValue={connection.displayName||provider.nameAr}
            />
          </label>}
          <label className={styles.field}>
            جدول المزامنة
            <select name="frequency" defaultValue={frequency}>
              {Object.entries(FREQUENCIES).map(([value,label])=><option
                value={value}
                key={value}
              >{label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            موعد المزامنة بتوقيت السعودية
            <input
              name="syncTime"
              type="time"
              step="300"
              defaultValue={connection.syncTime||'03:00'}
              required
            />
          </label>

          {(provider.requiredConfigKeys||[])
            .filter(key=>!(provider.providerKey==='custom'&&key==='authType'))
            .map(key=><ConfigField
              key={key}
              fieldKey={key}
              required
              value={configurationValue(provider,key,connection,configuration)}
            />)}

          {[
            ...(provider.requiredSecretKeys||[]),
            ...(provider.optionalSecretKeys||[])
          ].map(key=><SecretField
            key={key}
            fieldKey={key}
            required={
              (provider.requiredSecretKeys||[]).includes(key)
              &&!configuredSecrets.has(key)
            }
            configured={configuredSecrets.has(key)}
          />)}

          {provider.providerKey==='custom'&&<label className={styles.field}>
            طريقة المصادقة
            <select
              name="authType"
              defaultValue={configuration.authType||'none'}
            >
              <option value="none">بدون مصادقة</option>
              <option value="api_key">API Key</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
            </select>
          </label>}

          <fieldset className={styles.scope}>
            <legend>ما الذي تريد مزامنته؟</legend>
            {capabilities.map(key=><label key={key}>
              <input
                type="checkbox"
                name={`scope_${key}`}
                defaultChecked={
                  key==='products'||(connection.syncScope||[]).includes(key)
                }
                disabled={key==='products'}
              />
              <span>
                <b>{SCOPE_LABELS[key]||key}</b>
                <small>{scopeDescription(key)}</small>
              </span>
            </label>)}
            <label>
              <input
                type="checkbox"
                name="matchBySku"
                defaultChecked={Boolean(connection.matchBySku)}
              />
              <span>
                <b>مطابقة الدورات الحالية عبر SKU</b>
                <small>يربط التطابق الوحيد ولا ينشئ نسخة ثانية من الدورة.</small>
              </span>
            </label>
          </fieldset>

          <div className={styles.securityNote}>
            المفاتيح تُرسل للخادم مرة واحدة وتُحفظ مشفرة داخل Supabase Vault،
            ولا تظهر في سجلات التشغيل.
          </div>
          {provider.setupMode!=='manual'&&<div className={styles.readinessNote}>
            التشغيل العام بضغطة واحدة يحتاج اعتماد تطبيق ماركتون الرسمي لدى
            {' '}{provider.nameAr}. الربط اليدوي الحالي يعمل ببيانات وصول صالحة.
          </div>}
          {error&&<div className={styles.error}>{error}</div>}
        </div>
      </div>
      <footer>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onClose}
          disabled={Boolean(busy)}
        >إلغاء</button>
        <button className={styles.primaryButton} disabled={Boolean(busy)}>
          {busy==='save'?'جارٍ التشفير والحفظ…':'حفظ إعدادات الربط'}
        </button>
      </footer>
    </form>
  </div>;
}

function ConfigField({fieldKey,required,value}){
  const isUrl=fieldKey==='baseUrl'||fieldKey==='storeUrl';
  return <label className={styles.field}>
    {FIELD_LABELS[fieldKey]||fieldKey}
    <input
      name={fieldKey}
      required={required}
      type={isUrl?'url':'text'}
      dir="ltr"
      defaultValue={value}
      placeholder={fieldPlaceholder(fieldKey)}
    />
  </label>;
}

function SecretField({fieldKey,required,configured}){
  return <label className={styles.field}>
    {FIELD_LABELS[fieldKey]||fieldKey}
    <input
      name={fieldKey}
      required={required}
      type={SECRET_FIELDS.has(fieldKey)?'password':'text'}
      dir="ltr"
      autoComplete="off"
      placeholder={configured
        ?'محفوظ ومشفّر — اتركه دون تغيير'
        :'أدخل القيمة الآمنة'}
    />
  </label>;
}

function configurationValue(provider,key,connection,configuration){
  if(provider.providerKey==='woocommerce'&&key==='storeUrl'){
    return connection.storeUrl||configuration.storeUrl||'';
  }
  return configuration[key]||'';
}

function dateLabel(value){
  if(!value)return 'لم تتم بعد';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return 'غير محدد';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',timeZone:'Asia/Riyadh'
  }).format(date);
}

function dateTimeLabel(value){
  if(!value)return 'بعد اختبار الاتصال';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return 'غير محدد';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'
  }).format(date);
}

function syncTimeLabel(value){
  if(!/^\d{2}:\d{2}$/.test(String(value||'')))return '٣:٠٠ ص';
  const [hour,minute]=String(value).split(':').map(Number);
  return new Intl.DateTimeFormat('ar-SA',{
    hour:'numeric',minute:'2-digit',timeZone:'UTC'
  }).format(new Date(Date.UTC(2020,0,1,hour,minute)));
}

function fieldPlaceholder(key){
  return ({
    storeUrl:'https://store.example.com',
    storeId:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    shopDomain:'your-store.myshopify.com',
    baseUrl:'https://store.example.com/api',
    consumerKey:'ck_…',
    consumerSecret:'cs_…'
  })[key]||'';
}

function scopeDescription(key){
  return ({
    products:'الاسم والسعر والعرض والصور والمخزون والرابط.',
    categories:'هيكل أقسام المتجر.',
    attributes:'اللغة والمستوى والمدة والخصائص.',
    collections:'مجموعات Shopify المرتبطة بالكتالوج.',
    variations:'الخيارات وأسعارها ومخزونها.',
    variants:'الخيارات وأسعارها ومخزونها.',
    coupons:'رموز الخصم وشروطها.',
    discounts:'الخصومات وقواعدها.',
    orders:'حالة الطلب والدفع والاسترداد.',
    customers:'بيانات العميل اللازمة للتسجيل والتقارير.'
  })[key]||'بيانات موحدة قابلة للتوسع.';
}
