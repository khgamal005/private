'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

const FREQUENCIES={
  manual:'يدوي فقط',
  daily:'يومي',
  weekly:'أسبوعي',
  monthly:'شهري'
};

const STATUS={
  draft:'محفوظ ويحتاج اختبارًا',
  testing:'جارٍ اختبار الاتصال',
  active:'متصل',
  degraded:'متصل مع ملاحظات',
  disabled:'متوقف',
  error:'يحتاج مراجعة'
};

const DEFAULT_SCOPE={
  products:true,
  categories:true,
  attributes:true,
  variations:true,
  coupons:true,
  orders:false,
  customers:false,
  matchBySku:false
};

const SCOPE_FIELDS=[
  ['categories','التصنيفات والوسوم','بنية أقسام المتجر المرتبطة بالدورات.'],
  ['attributes','السمات والقيم','اللغة والمستوى والمدة وأي خصائص مضافة.'],
  ['variations','خيارات المنتجات','الأسعار والمخزون وSKU لكل خيار من الدورة.'],
  ['coupons','الكوبونات والعروض','قيمة الخصم وشروطه وصلاحيته وحدود الاستخدام.'],
  ['orders','الطلبات والمدفوعات (اختياري)','نسخة تجارية للطلبات وحالات الدفع والاسترداد؛ فعّلها بعد نجاح مزامنة الدورات.'],
  ['customers','العملاء (اختياري)','بيانات العملاء اللازمة للربط والتقارير؛ قد تزيد مدة أول مزامنة في المتاجر الكبيرة.']
];

export default function WooCommerceSyncPanel({
  slug,
  initialData,
  canManage
}){
  const router=useRouter();
  const data=initialData||{};
  const connection=data.connection||null;
  const counts=data.counts||{};
  const recentRuns=data.recentRuns
    ||(data.lastSync?[data.lastSync]:[]);
  const configuredSecrets=connection?.configuredSecrets||[];
  const featureEnabled=data.featureEnabled!==false;
  const connectionFrequency=connection?.syncFrequency
    ||connection?.frequency
    ||'weekly';
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [frequency,setFrequency]=useState(connectionFrequency);
  const [scope,setScope]=useState(
    initialScope(connection?.syncScope,connection?.matchBySku)
  );
  const lastRun=recentRuns[0]||null;
  const configured=Boolean(connection);
  const credentialsReady=configuredSecrets.includes('consumerKey')
    &&configuredSecrets.includes('consumerSecret');

  async function call(action,body={}){
    const response=await fetch(`/api/woocommerce/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({tenantSlug:slug,...body})
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(
      payload.error||'تعذر تنفيذ عملية WooCommerce'
    );
    return payload.data||payload;
  }

  async function save(event){
    event.preventDefault();
    setBusy('save');
    setError('');
    setNotice('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      await call('save',{
        payload:{
          storeUrl:String(values.store_url||'').trim(),
          frequency,
          matchBySku:Boolean(scope.matchBySku),
          syncScope:scopeList(scope),
          secrets:{
            consumerKey:String(values.consumer_key||'').trim(),
            consumerSecret:String(values.consumer_secret||'').trim()
          }
        }
      });
      setModal(false);
      setNotice(
        'تم حفظ الربط وتشفير المفاتيح. اختبر الاتصال قبل أول مزامنة.'
      );
      router.refresh();
    }catch(reason){
      setError(reason.message);
    }finally{
      setBusy('');
    }
  }

  async function testConnection(){
    setBusy('test');
    setError('');
    setNotice('');
    try{
      const result=await call('test');
      const store=result.store||result.remoteMetadata||{};
      setNotice(
        `نجح الاتصال${store.name?` بمتجر ${store.name}`:''}.`
        +' أصبح الربط جاهزًا للمزامنة.'
      );
      router.refresh();
    }catch(reason){
      setError(reason.message);
      router.refresh();
    }finally{
      setBusy('');
    }
  }

  async function syncNow(){
    setBusy('sync');
    setError('');
    setNotice('جارٍ قراءة بيانات WooCommerce وحفظها دون تكرار…');
    try{
      const result=await call('sync');
      const stats=result.stats||{};
      const total=Number(
        stats.total
        ??Object.values(stats.totals||{}).reduce(
          (sum,value)=>sum+(Number(value)||0),
          0
        )
      );
      setNotice(
        `اكتملت المزامنة بنجاح: `
        +`${total.toLocaleString('ar-SA')} سجل تمت مراجعته.`
      );
      router.refresh();
    }catch(reason){
      setNotice('');
      setError(reason.message);
      router.refresh();
    }finally{
      setBusy('');
    }
  }

  async function disable(){
    if(!window.confirm(
      'إيقاف مزامنة WooCommerce؟ ستظل البيانات والمفاتيح المشفرة محفوظة.'
    ))return;
    setBusy('disable');
    setError('');
    try{
      await call('disable',{payload:{}});
      setNotice('تم إيقاف المزامنة مع الاحتفاظ بالبيانات الحالية.');
      router.refresh();
    }catch(reason){
      setError(reason.message);
    }finally{
      setBusy('');
    }
  }

  return <section className={
    `mt-woocommerce-sync ${connection?.status||'unconfigured'}`
  }>
    <header>
      <div className="mt-woocommerce-brand">
        <span>Woo</span>
        <div>
          <small>WOOCOMMERCE CONNECTOR</small>
          <h3>ربط متجر البرامج والدورات</h3>
          <p>
            نقل الدورات والأسعار والعروض والصور والطلبات والعملاء من
            WooCommerce إلى ماركتون.
          </p>
        </div>
      </div>
      <div className="mt-woocommerce-state">
        <span className={`mt-provider-state ${
          connection?.status==='active'?'ready':connection?.status||'draft'
        }`}>
          {configured
            ?STATUS[connection.status]||connection.status
            :'غير مربوط'}
        </span>
        {canManage&&<button
          type="button"
          className="mt-button"
          onClick={()=>setModal(true)}
          disabled={Boolean(busy)||!featureEnabled}
        >{featureEnabled
            ?configured?'تعديل الربط':'ربط المتجر'
            :'الإضافة غير مفعلة'}</button>}
      </div>
    </header>

    {configured&&<div className="mt-woocommerce-body">
      <div className="mt-woocommerce-stats">
        <WooStat
          value={counts.products??counts.courses??0}
          label="دورة/منتج"
        />
        <WooStat value={counts.coupons??0} label="كوبون وعرض"/>
        <WooStat value={counts.orders??0} label="طلب"/>
        <WooStat value={counts.customers??0} label="عميل"/>
      </div>
      <dl className="mt-woocommerce-meta">
        <div>
          <dt>المتجر</dt>
          <dd dir="ltr">{connection.storeUrl}</dd>
        </div>
        <div>
          <dt>آخر مزامنة ناجحة</dt>
          <dd>{dateLabel(connection.lastSyncedAt)}</dd>
        </div>
        <div>
          <dt>المزامنة التالية</dt>
          <dd>
            {connection.syncFrequency==='manual'
              ||connection.frequency==='manual'
              ?'يدويًا عند الطلب'
              :dateLabel(connection.nextSyncAt)}
          </dd>
        </div>
        <div>
          <dt>الجدول</dt>
          <dd>{FREQUENCIES[connectionFrequency]||'أسبوعي'}</dd>
        </div>
      </dl>
      {lastRun&&<div className={`mt-woocommerce-last-run ${lastRun.status}`}>
        <span>آخر تشغيل: {runStatus(lastRun.status)}</span>
        <small>
          {dateLabel(lastRun.finishedAt||lastRun.startedAt)}
          {lastRun.error?` · ${lastRun.error}`:''}
        </small>
      </div>}
      <footer>
        {canManage&&<>
          <button
            type="button"
            className="mt-button"
            onClick={testConnection}
            disabled={Boolean(busy)||!credentialsReady}
          >{busy==='test'?'جارٍ الاختبار…':'اختبار الاتصال'}</button>
          <button
            type="button"
            className="mt-button primary"
            onClick={syncNow}
            disabled={
              Boolean(busy)
              ||!credentialsReady
              ||connection.status==='disabled'
            }
          >{busy==='sync'?'جارٍ المزامنة…':'مزامنة الآن'}</button>
          {connection.status!=='disabled'&&<button
            type="button"
            className="mt-link-button danger"
            onClick={disable}
            disabled={Boolean(busy)}
          >إيقاف</button>}
        </>}
      </footer>
    </div>}

    {!configured&&<div className="mt-woocommerce-empty">
      <div>
        <b>{featureEnabled
          ?'مزامنة واحدة بدل إدخال الدورات يدويًا'
          :'إضافة WooCommerce غير مفعلة لهذه المنشأة'}</b>
        <p>
          {featureEnabled
            ?'WooCommerce يظل مصدر البيانات التجارية، بينما تضيف ماركتون التشغيل والدفعات والتسجيل والقبول دون تغيير المتجر.'
            :'فعّل الإضافة من الباقة أو مركز الإضافات قبل حفظ مفاتيح المتجر.'}
        </p>
      </div>
      <ol>
        <li>أنشئ مفتاح REST API بصلاحية قراءة</li>
        <li>احفظ الرابط والمفتاح المشفّر</li>
        <li>اختبر الاتصال ثم ابدأ المزامنة</li>
      </ol>
    </div>}

    {notice&&<div className="mt-alert mt-woocommerce-alert">{notice}</div>}
    {error&&<div className="mt-alert error mt-woocommerce-alert">{error}</div>}
    {connection?.lastError&&!error&&<div className="mt-alert error mt-woocommerce-alert">
      آخر ملاحظة: {connection.lastError}
    </div>}

    {modal&&<div className="mt-modal-layer">
      <button
        className="mt-modal-backdrop"
        aria-label="إغلاق"
        onClick={()=>!busy&&setModal(false)}
      />
      <form
        className="mt-modal mt-woocommerce-modal"
        onSubmit={save}
      >
        <header>
          <div>
            <small>WOOCOMMERCE REST API</small>
            <h3>{configured?'تعديل ربط المتجر':'ربط متجر WooCommerce'}</h3>
            <p>
              استخدم مفتاح Read فقط. لا نحتاج كلمة مرور مدير WordPress.
            </p>
          </div>
          <button type="button" onClick={()=>setModal(false)}>×</button>
        </header>
        <div className="mt-integration-modal-body">
          <div className="mt-setup-note">
            <span>1</span>
            <p>
              من WordPress: WooCommerce ← الإعدادات ← متقدم ← REST API
              ← إضافة مفتاح بصلاحية قراءة.
            </p>
          </div>
          <div className="mt-form">
            <label className="mt-field wide">
              رابط متجر WordPress
              <input
                name="store_url"
                type="url"
                dir="ltr"
                required
                defaultValue={connection?.storeUrl||''}
                placeholder="https://store.example.com"
              />
            </label>
            <label className="mt-field">
              Consumer Key
              <input
                name="consumer_key"
                type="password"
                dir="ltr"
                required={!credentialsReady}
                placeholder={credentialsReady?'محفوظ ومشفّر — اتركه دون تغيير':'ck_…'}
                autoComplete="off"
              />
            </label>
            <label className="mt-field">
              Consumer Secret
              <input
                name="consumer_secret"
                type="password"
                dir="ltr"
                required={!credentialsReady}
                placeholder={credentialsReady?'محفوظ ومشفّر — اتركه دون تغيير':'cs_…'}
                autoComplete="off"
              />
            </label>
            <label className="mt-field">
              جدول المزامنة
              <select
                value={frequency}
                onChange={event=>setFrequency(event.target.value)}
              >
                {Object.entries(FREQUENCIES).map(([value,label])=>
                  <option value={value} key={value}>{label}</option>
                )}
              </select>
            </label>
            <div className="mt-field wide mt-woocommerce-scope">
              <b>ما الذي تريد مزامنته؟</b>
              <label className="mt-checkbox-card">
                <input type="checkbox" checked disabled readOnly/>
                <span>
                  <b>الدورات والمنتجات والأسعار والصور</b>
                  <small>أساسي دائمًا، ويشمل سعر العرض ومدته والمخزون.</small>
                </span>
              </label>
              {SCOPE_FIELDS.map(([key,label,description])=>
                <label className="mt-checkbox-card" key={key}>
                  <input
                    type="checkbox"
                    checked={Boolean(scope[key])}
                    onChange={event=>setScope(current=>({
                      ...current,
                      [key]:event.target.checked
                    }))}
                  />
                  <span><b>{label}</b><small>{description}</small></span>
                </label>
              )}
              <label className="mt-checkbox-card">
                <input
                  type="checkbox"
                  checked={Boolean(scope.matchBySku)}
                  onChange={event=>setScope(current=>({
                    ...current,
                    matchBySku:event.target.checked
                  }))}
                />
                <span>
                  <b>ربط الدورات الحالية بكود SKU</b>
                  <small>
                    اختياري. يربط التطابق الوحيد بالأسعار فقط، ولا يغيّر
                    اسم الدورة أو وصفها أو بياناتها الأكاديمية.
                  </small>
                </span>
              </label>
            </div>
            <div className="mt-secret-banner mt-field wide">
              المفاتيح تُحفظ مشفّرة في Supabase Vault ولا تعود إلى
              المتصفح أو تظهر في السجلات بعد الحفظ.
            </div>
            {error&&<div className="mt-alert error mt-field wide">{error}</div>}
          </div>
        </div>
        <footer>
          <button
            type="button"
            className="mt-button"
            onClick={()=>setModal(false)}
            disabled={Boolean(busy)}
          >إلغاء</button>
          <button className="mt-button primary" disabled={Boolean(busy)}>
            {busy==='save'?'جارٍ الحفظ والتشفير…':'حفظ الربط'}
          </button>
        </footer>
      </form>
    </div>}
  </section>;
}

function WooStat({value,label}){
  return <div>
    <b>{Number(value||0).toLocaleString('ar-SA')}</b>
    <span>{label}</span>
  </div>;
}

function dateLabel(value){
  if(!value)return 'لم تتم بعد';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return 'غير محدد';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',
    timeStyle:'short'
  }).format(date);
}

function runStatus(value){
  return ({
    queued:'في الانتظار',
    running:'جارٍ التنفيذ',
    success:'ناجحة',
    succeeded:'ناجحة',
    partial:'اكتملت جزئيًا',
    failed:'فشلت'
  })[value]||value;
}

function initialScope(value,matchBySku=false){
  if(Array.isArray(value)){
    const enabled=new Set(value);
    return {
      ...DEFAULT_SCOPE,
      categories:enabled.has('categories'),
      attributes:
        enabled.has('attributes')||enabled.has('attribute_terms'),
      variations:enabled.has('variations'),
      coupons:enabled.has('coupons'),
      orders:enabled.has('orders'),
      customers:enabled.has('customers'),
      matchBySku:Boolean(matchBySku)
    };
  }
  return {
    ...DEFAULT_SCOPE,
    ...(value&&typeof value==='object'?value:{}),
    matchBySku:Boolean(matchBySku)
  };
}

function scopeList(scope){
  const values=['products'];
  if(scope.categories)values.push('categories');
  if(scope.attributes)values.push('attributes','attribute_terms');
  if(scope.variations)values.push('variations');
  if(scope.coupons)values.push('coupons');
  if(scope.orders)values.push('orders');
  if(scope.customers)values.push('customers');
  return values;
}
