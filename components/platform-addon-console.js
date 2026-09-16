'use client';

import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import TamaraSetupForm from './tamara-setup-form';
import styles from './platform-addon-console.module.css';

const EMPTY=[];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABS=[
  ['catalog','كتالوج الإضافات'],
  ['categories','أقسام الإضافات'],
  ['licenses','تراخيص المنشآت']
];
const STATUS={
  pending:'بانتظار القرار',trialing:'تجريبية',active:'نشطة',paused:'موقوفة',
  cancelled:'ملغاة',expired:'منتهية',draft:'مسودة',configured:'جاهزة للاختبار',
  disabled:'معطلة',error:'خطأ اتصال',published:'منشورة',archived:'مؤرشفة'
};
const PUBLIC_CONFIG_LABEL={
  merchantId:'معرّف التاجر',merchantAccountId:'معرّف حساب التاجر',
  integrationId:'Integration ID الأساسي',
  applePayIntegrationId:'Integration ID لـ Apple Pay',
  integrationPath:'مسار الربط',webhookId:'معرّف Webhook',
  region:'منطقة تشغيل Paymob'
};
const SECRET_LABEL={
  apiToken:'API Token — مفتاح اتصال تمارا',
  notificationToken:'Notification key — مفتاح إشعارات تمارا',
  secretKey:'Secret Key (Unified Checkout والعمليات المحكومة)',
  publicKey:'Public Key (Unified Checkout)',
  hmacSecret:'HMAC Secret (توثيق Webhook)',
  apiKey:'API Key (QuickLink والاستعلام والمطابقة)'
};
const PAYMOB_REQUIRED_SECRET_KEYS=['apiKey','hmacSecret'];
const PAYMOB_PUBLIC_CONFIG_KEYS=[
  'merchantAccountId','integrationPath','integrationId',
  'applePayIntegrationId','region'
];
const PAYMOB_OPERATIONAL_CHECKS=[
  'refund_initiation','live_credentials','live_card_integration_callback',
  'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
];
const PAYMOB_CHECK_LABEL={
  credentials:'الاعتمادات',intention_create:'إنشاء مسار الدفع',
  webhook_hmac:'توقيع Webhook',paid_transaction:'عملية ناجحة',
  duplicate_delivery:'منع التكرار',failed_transaction:'عملية فاشلة',
  transaction_inquiry:'المطابقة',refund_inquiry:'التحقق من الاسترداد',
  refund_initiation:'بدء الاسترداد',
  credential_rotation_callback:'Webhook بعد تدوير الاعتمادات',
  edge_query_redaction_waf:'حجب Query من سجلات الحافة',
  reconciler_schedule:'جدولة المطابقة',outbox_delivery:'تسليم Outbox',
  live_credentials:'اعتمادات Live',
  live_card_integration_callback:'عملية Card حية'
};

function unique(values){return [...new Set(values)]}

function providerRequiredSecretKeys(provider){
  if(provider.key==='paymob')return PAYMOB_REQUIRED_SECRET_KEYS;
  return unique(provider.requiredSecretKeys||EMPTY);
}

function providerSecretKeys(provider){
  if(provider.key==='paymob')return PAYMOB_REQUIRED_SECRET_KEYS;
  return unique([
    ...providerRequiredSecretKeys(provider),
    ...(provider.optionalSecretKeys||EMPTY)
  ]);
}

function providerPublicConfigKeys(provider){
  return unique([
    ...(provider.requiredPublicConfigKeys||EMPTY),
    ...(provider.key==='paymob'?PAYMOB_PUBLIC_CONFIG_KEYS:EMPTY)
  ]);
}
function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency,maximumFractionDigits:0
  }).format((Number(amountMinor)||0)/100);
}

function formatDate(value){
  if(!value)return '—';
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',timeZone:'Asia/Riyadh'
  }).format(parsed);
}

function today(){return new Date().toISOString().slice(0,10);}

function annualEnd(start){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  if(!match)return start;
  const nextYear=Number(match[1])+1;
  const month=match[2];
  const day=month==='02'&&match[3]==='29'
    &&!(nextYear%4===0&&(nextYear%100!==0||nextYear%400===0))
    ?'28'
    :match[3];
  return `${nextYear}-${month}-${day}`;
}

export default function PlatformAddonConsole({initialData,section='addons'}){
  const router=useRouter();
  const data=initialData||{};
  const tabs=section==='providers'?[['providers','وسائل الدفع']]:TABS;
  const [tab,setTab]=useState(section==='providers'?'providers':'catalog');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [paymobControl,setPaymobControl]=useState({
    loading:section==='providers',data:null,error:''
  });
  const closeModal=useCallback(()=>setModal(null),[setModal]);
  const products=data.products||EMPTY;
  const subscriptions=data.subscriptions||EMPTY;
  const categories=data.addonCategories||EMPTY;
  const providers=data.paymentProviders||EMPTY;
  const tenants=data.tenants||EMPTY;
  const summary=data.summary||{};

  const loadPaymobControl=useCallback(async()=>{
    if(section!=='providers')return;
    setPaymobControl(current=>({...current,loading:true,error:''}));
    try{
      const response=await fetch('/api/platform/paymob-control',{
        method:'GET',cache:'no-store',headers:{accept:'application/json'}
      });
      const result=await response.json();
      if(!response.ok||!result?.data){
        throw new Error(result?.error||'تعذر تحميل حوكمة Paymob');
      }
      setPaymobControl({loading:false,data:result.data,error:''});
    }catch(err){
      setPaymobControl({
        loading:false,data:null,
        error:err instanceof Error?err.message:'تعذر تحميل حوكمة Paymob'
      });
    }
  },[section]);

  useEffect(()=>{void loadPaymobControl()},[loadPaymobControl]);

  const filtered=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    const source=tab==='catalog'?products:tab==='licenses'?subscriptions:tab==='providers'?providers:categories;
    return source.filter(item=>!needle||[
      item.name,item.key,item.productName,item.productKey,
      item.nameEn,item.description,item.badge,item.tenantName,
      item.tenantSlug,item.status,item.categoryName
    ].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle)));
  },[categories,products,providers,query,subscriptions,tab]);

  async function platformAction(action,payload){
    const response=await fetch('/api/platform/addon-decision',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({p_action:action,p_payload:payload})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data;
  }

  async function savePrice(event){
    event.preventDefault();
    setBusy('price');setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const item=modal.item;
    try{
      if(item.independent){
        const pricingMode=values.pricing_mode==='free'?'free':'fixed';
        const monthlyAmountMinor=pricingMode==='free'
          ?0
          :Math.round(Number(values.monthly_amount||0)*100);
        await platformAction('set_independent_price',{
          productId:item.id,
          expectedOfferId:item.price?.offerId||null,
          expectedMonthlyAmountMinor:Number.isSafeInteger(item.monthlyAmountMinor)
            ?item.monthlyAmountMinor:null,
          expectedAnnualAmountMinor:Number.isSafeInteger(item.annualAmountMinor)
            ?item.annualAmountMinor:null,
          pricingMode,
          monthlyAmountMinor,
          confirmed:true,
          reason:values.reason
        });
        setNotice(pricingMode==='free'
          ?'أصبحت الإضافة مجانية وتُفعّل مباشرة دون إنشاء طلب دفع.'
          :'تم حفظ السعر الشهري والسنوي الجديد دون إعادة تسعير أي طلب سابق.');
      }else{
        await platformAction('set_annual_price',{
          productKey:item.key,
          amountMinor:Math.round(Number(values.amount||0)*100),
          currency:values.currency,
          validFrom:values.valid_from,
          taxRateBps:1500,
          reason:values.reason
        });
        setNotice('تمت إضافة نسخة سعر سنوية جديدة دون تغيير الأسعار التاريخية.');
      }
      setModal(null);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function saveProduct(event){
    event.preventDefault();
    setBusy('product');setError('');setNotice('');
    const form=new FormData(event.currentTarget);
    const marketplaceVisible=form.get('marketplace_visible')==='on';
    try{
      await platformAction('update_product_catalog',{
        productId:modal.item.id,
        expectedUpdatedAt:modal.item.updatedAt,
        nameAr:String(form.get('name_ar')||'').trim(),
        nameEn:String(form.get('name_en')||'').trim()||null,
        descriptionAr:String(form.get('description_ar')||'').trim(),
        badgeAr:String(form.get('badge_ar')||'').trim()||null,
        displayOrder:Number(form.get('display_order')||100),
        marketplaceVisible,
        reason:String(form.get('reason')||'').trim()
      });
      setModal(null);
      setNotice(marketplaceVisible
        ?'تم تحديث معلومات الإضافة وإظهارها في المتجر.'
        :'تم إخفاء الإضافة من المتجر فقط؛ تراخيص المنشآت وبياناتها ما زالت تعمل.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function decide(subscription,decision){
    setBusy(`${decision}-${subscription.id}`);setError('');setNotice('');
    try{
      await platformAction('decide_request',{
        subscriptionId:subscription.id,decision,
        note:'قرار من لوحة إدارة الإضافات v3'
      });
      setNotice('تم تسجيل القرار في سجل التدقيق.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function setLicenseStatus(subscription,status){
    setBusy(`${status}-${subscription.id}`);setError('');setNotice('');
    try{
      await platformAction('set_subscription_status',{
        subscriptionId:subscription.id,status,
        reason:'تغيير تشغيلي من لوحة إدارة الإضافات'
      });
      setNotice('تم تحديث حالة الترخيص دون حذف بيانات المنشأة.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function grantLicense(event){
    event.preventDefault();
    setBusy('grant');setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await platformAction('grant_subscription',{
        tenantId:values.tenant_id,
        productKey:values.product_key,
        startsAt:`${values.starts_at}T00:00:00+03:00`,
        endsAt:`${values.ends_at}T00:00:00+03:00`,
        reason:values.reason
      });
      setModal(null);
      setNotice('تم منح الترخيص للفترة المحددة مع الاحتفاظ الكامل بالبيانات.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function saveProvider(event){
    event.preventDefault();
    setBusy('provider');setError('');setNotice('');
    const form=new FormData(event.currentTarget);
    const provider=modal.item;
    try{
      const secrets={};
      for(const secretKey of providerSecretKeys(provider)){
        const secretValue=String(form.get(`secret_${secretKey}`)||'').trim();
        if(secretValue)secrets[secretKey]=secretValue;
      }
      const publicConfig={};
      for(const configKey of providerPublicConfigKeys(provider)){
        const configValue=provider.key==='paymob'&&configKey==='region'
          ?'ksa'
          :provider.key==='paymob'&&configKey==='integrationPath'
            ?'quicklink'
            :String(form.get(`public_${configKey}`)||'').trim();
        if(configValue)publicConfig[configKey]=configValue;
        else if(provider.key==='paymob'&&configKey==='applePayIntegrationId'){
          // Explicit null clears a previously configured optional Integration
          // instead of letting the server-side merge retain stale routing.
          publicConfig[configKey]=null;
        }
      }
      const paymob=provider.key==='paymob';
      const response=await fetch('/api/platform/payment-provider-secret',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          providerKey:provider.key,environment:form.get('environment'),
          checkoutMode:paymob?'redirect':form.get('checkout_mode'),
          supportedCurrencies:paymob?['SAR']:String(form.get('currencies')||'').split(',').map(value=>value.trim().toUpperCase()).filter(Boolean),
          enabled:form.get('enabled')==='on',publicConfig,secrets
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر حفظ الاتصال');
      setModal(null);setNotice('حُفظ الإعداد. سيظل المزود غير نشط حتى ينجح اختبار Adapter وWebhook فعلي.');
      await loadPaymobControl();router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function runPaymobControl(event){
    event.preventDefault();
    if(modal?.type!=='paymob-control')return;
    const typed=String(new FormData(event.currentTarget)
      .get('confirmation')||'');
    if(typed!==modal.expected){
      setError('اكتب نص التأكيد كما هو قبل تنفيذ الإجراء.');
      return;
    }
    setBusy('paymob-control');setError('');setNotice('');
    try{
      const response=await fetch('/api/platform/paymob-control',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...modal.request,confirmation:typed})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ إجراء Paymob');
      setModal(null);
      setNotice(modal.successMessage);
      await loadPaymobControl();
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر تنفيذ إجراء Paymob');
    }finally{setBusy('')}
  }

  async function commerceAction(action,payload){
    const response=await fetch('/api/platform/commerce',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({p_action:action,p_payload:payload})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data;
  }

  async function saveCategory(event){
    event.preventDefault();
    setBusy('category');setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await commerceAction('save_addon_category',{
        categoryId:modal.item?.id||null,key:values.key,name:values.name,
        description:values.description,iconKey:values.icon_key,
        displayOrder:Number(values.display_order||100)
      });
      setModal(null);
      setNotice('تم حفظ قسم الإضافات.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function assignCategory(event){
    event.preventDefault();setBusy('assign-category');setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await commerceAction('assign_addon_category',{
        productId:modal.item.id,categoryId:values.category_id
      });
      setModal(null);setNotice('تم نقل الإضافة إلى القسم المحدد.');router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  return <section className={styles.console} aria-busy={Boolean(busy)}>
    <header className={styles.hero}>
      <div><small>{section==='providers'?'PAYMENT PROVIDERS':'ADD-ON OPERATING SYSTEM'}</small><h1>{section==='providers'?'وسائل الدفع':'متجر الإضافات والتراخيص'}</h1><p>{section==='providers'?'إعداد مركزي آمن لتمارا وPaymob وPayPal وبقية بوابات التحصيل.':'كتالوج إضافات برمجية مستقل عن الخدمات، مع أقسام وأسعار مؤرخة وتراخيص معزولة لكل منشأة.'}</p></div>
      {tab==='licenses'?<button type="button" onClick={()=>setModal({type:'grant'})}>+ منح ترخيص</button>:tab==='categories'?<button type="button" onClick={()=>setModal({type:'category'})}>+ قسم جديد</button>:null}
    </header>

    {section!=='providers'&&<section className={styles.kpis}>
      <article><span>ظاهرة في المتجر</span><b>{summary.visibleProducts??summary.publishedProducts??summary.products??0}</b><small>متاحة للاشتراك أو التفعيل</small></article>
      <article><span>مخفية من المتجر</span><b>{summary.hiddenProducts??0}</b><small>تظل فعالة للمشتركين الحاليين</small></article>
      <article><span>التراخيص النشطة</span><b>{summary.activeLicenses||0}</b><small>مع فحص تاريخ الانتهاء</small></article>
      <article><span>تنتهي خلال 30 يومًا</span><b>{summary.expiringWithin30Days||0}</b><small>تحتاج متابعة تجديد</small></article>
    </section>}

    <nav className={styles.tabs} role="tablist" aria-label="أقسام إدارة الإضافات">
      {tabs.map(([key,label])=><button type="button" role="tab" id={`addon-tab-${key}`} aria-controls={`addon-panel-${key}`} aria-selected={tab===key} key={key} onClick={()=>{setTab(key);setQuery('')}}>{label}</button>)}
    </nav>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}

    <section className={styles.toolbar}>
      <div><b>{tabs.find(([key])=>key===tab)?.[1]}</b><small>{filtered.length} سجل</small></div>
      <input value={query} onChange={event=>setQuery(event.target.value)} aria-label="بحث" placeholder="ابحث باسم الإضافة أو المنشأة…"/>
    </section>

    <section role="tabpanel" id={`addon-panel-${tab}`} aria-labelledby={`addon-tab-${tab}`}>
      {tab==='catalog'&&<Catalog rows={filtered} onEdit={item=>setModal({type:'product',item})} onPrice={item=>setModal({type:'price',item})} onCategory={item=>setModal({type:'assign-category',item})}/>} 
      {tab==='categories'&&<Categories rows={filtered} onEdit={item=>setModal({type:'category',item})}/>} 
      {tab==='licenses'&&<Licenses rows={filtered} busy={busy} onDecision={decide} onStatus={setLicenseStatus}/>} 
      {tab==='providers'&&<><PaymobGovernance
        control={paymobControl}
        tenants={tenants}
        onRefresh={loadPaymobControl}
        onAction={action=>setModal({type:'paymob-control',...action})}
      /><Providers rows={filtered} onConfigure={item=>setModal({type:'provider',item})}/></>} 
    </section>

    {modal?.type==='price'&&<PriceModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={savePrice}/>} 
    {modal?.type==='product'&&<ProductModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={saveProduct}/>} 
    {modal?.type==='grant'&&<GrantModal products={products} tenants={tenants} busy={busy} onClose={closeModal} onSubmit={grantLicense}/>} 
    {modal?.type==='category'&&<CategoryModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={saveCategory}/>} 
    {modal?.type==='assign-category'&&<AssignCategoryModal item={modal.item} categories={categories} busy={busy} onClose={closeModal} onSubmit={assignCategory}/>} 
    {modal?.type==='provider'&&<ProviderModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={saveProvider}/>} 
    {modal?.type==='paymob-control'&&<PaymobControlModal
      action={modal} busy={busy} onClose={closeModal}
      onSubmit={runPaymobControl}
    />}
  </section>;
}

function Catalog({rows,onEdit,onPrice,onCategory}){
  return <div className={styles.table}>
    <header><span>الإضافة</span><span>القسم</span><span>السعر الشهري والسنوي</span><span>الإصدار والمتجر</span><span>حالة التشغيل</span><span/></header>
    {rows.map(item=>{
      const price=item.price||{};
      const activeMedia=(item.media||EMPTY).filter(media=>media.status==='active').length;
      const marketplaceVisible=item.marketplaceVisible!==false;
      return <article key={item.id||item.key}>
        <div><b>{item.name}</b><small>{item.key}</small></div>
        <div><b>{item.categoryName||'غير مصنفة'}</b><small>{item.surfaces?.length||0} موضع ظهور</small></div>
        <div>{item.independent
          ?item.pricingConfigured===false
            ?<><b>غير مسعّرة</b><small>اختر مجانية أو حدّد السعر</small></>
            :item.pricingMode==='free'&&item.monthlyAmountMinor===0
              ?<><b>مجانية</b><small>تفعيل فوري دون دفع</small></>
              :<><b>{money(item.monthlyAmountMinor,price.currency)} / شهر</b><small>{money(item.annualAmountMinor,price.currency)} / سنة</small></>
          :<><b>{money(price.amountMinor,price.currency)}</b><small>من {formatDate(price.validFrom)}</small></>}</div>
        <div><b>{item.manifest?.version||'—'}</b><span className={`${styles.storeState} ${marketplaceVisible?styles.storeVisible:styles.storeHidden}`}>{marketplaceVisible?'ظاهرة في المتجر':'مخفية من المتجر'}</span><small>{activeMedia} صور معتمدة · {item.media?.length||0} خانات</small></div>
        <Status value={item.manifest?.status||item.status}/>
        <div className={styles.actions}><button type="button" className={styles.manage} onClick={()=>onEdit(item)}>إدارة</button><button type="button" onClick={()=>onCategory(item)}>تصنيف</button><button type="button" onClick={()=>onPrice(item)}>تسعير</button></div>
      </article>;
    })}
    {!rows.length&&<Empty/>}
  </div>;
}

function Categories({rows,onEdit}){
  return <section className={styles.providers}>{rows.map(item=><article key={item.id}>
    <header><i>{item.iconKey?.slice(0,2)||'إ'}</i><Status value={item.status}/></header>
    <h2>{item.name}</h2><p>{item.description||'قسم إضافات أودير'}</p>
    <dl><div><dt>عدد الإضافات</dt><dd>{item.productCount||0}</dd></div><div><dt>المفتاح</dt><dd>{item.key}</dd></div></dl>
    <button type="button" onClick={()=>onEdit(item)}>تعديل القسم</button>
  </article>)}{!rows.length&&<Empty/>}</section>;
}

function Licenses({rows,busy,onDecision,onStatus}){
  return <div className={styles.table}>
    <header><span>المنشأة</span><span>الإضافة</span><span>الفترة</span><span>المصدر</span><span>الحالة</span><span>الإجراء</span></header>
    {rows.map(item=><article key={item.id}>
      <div><b>{item.tenantName}</b><small>{item.tenantSlug}{item.protected?' · محمي':''}</small></div>
      <div><b>{item.productName}</b><small>{item.productKey}</small></div>
      <div><b>{formatDate(item.startsAt)} ← {formatDate(item.endsAt)}</b><small>{item.daysRemaining==null?'غير مؤرخة':`${item.daysRemaining} يوم متبقٍ`}</small></div>
      <div><b>{item.source}</b><small>{item.autoRenew?'تجديد تلقائي':'تجديد يدوي'}</small></div>
      <Status value={item.effectiveStatus||item.status}/>
      <div className={styles.actions}>
        {item.status==='pending'?<>
          <button disabled={Boolean(busy)} onClick={()=>onDecision(item,'approve_trial')}>تجربة</button>
          <button disabled={Boolean(busy)} onClick={()=>onDecision(item,'approve_active')}>تفعيل سنة</button>
          <button disabled={Boolean(busy)} onClick={()=>onDecision(item,'reject')}>رفض</button>
        </>:<>
          {item.status==='active'&&<button disabled={Boolean(busy)||item.protected} onClick={()=>onStatus(item,'paused')}>إيقاف مؤقت</button>}
          {item.status==='paused'&&<button disabled={Boolean(busy)} onClick={()=>onStatus(item,'active')}>استئناف</button>}
          {!['cancelled','expired'].includes(item.status)&&<button disabled={Boolean(busy)||item.protected} onClick={()=>onStatus(item,'cancelled')}>إلغاء</button>}
        </>}
      </div>
    </article>)}
    {!rows.length&&<Empty/>}
  </div>;
}

function PaymobGovernance({control,tenants,onRefresh,onAction}){
  const snapshot=control.data;
  const availableTenants=useMemo(()=>{
    const byId=new Map();
    for(const tenant of [...(tenants||EMPTY),...(snapshot?.tenantRollouts||EMPTY)]){
      const tenantId=String(tenant.id||tenant.tenantId||'');
      const tenantSlug=String(tenant.slug||tenant.tenantSlug||'')
        .trim().toLowerCase();
      const tenantKey=String(tenant.tenantKey||'').trim().toLowerCase();
      if(!UUID.test(tenantId))continue;
      byId.set(tenantId,{
        id:tenantId,
        name:String(tenant.name||tenant.tenantName||tenantSlug||'منشأة'),
        slug:tenantSlug
      });
    }
    return [...byId.values()].sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  },[snapshot?.tenantRollouts,tenants]);
  const [tenantId,setTenantId]=useState('');
  const [environment,setEnvironment]=useState('live');
  const [evidenceCheck,setEvidenceCheck]=useState(PAYMOB_OPERATIONAL_CHECKS[0]);
  const [artifactSha256,setArtifactSha256]=useState('');
  useEffect(()=>{
    if(!availableTenants.some(tenant=>tenant.id===tenantId)){
      setTenantId(availableTenants[0]?.id||'');
    }
  },[availableTenants,tenantId]);

  if(control.loading&&!snapshot){
    return <section className={styles.governance} aria-busy="true">
      <p>جارٍ تحميل بوابة تشغيل Paymob…</p>
    </section>;
  }
  if(control.error||!snapshot){
    return <section className={`${styles.governance} ${styles.governanceError}`}>
      <div><h2>تشغيل Paymob</h2><p>{control.error||'بيانات الجاهزية غير متاحة.'}</p></div>
      <button type="button" onClick={()=>void onRefresh()}>إعادة المحاولة</button>
    </section>;
  }

  const missing=(snapshot.missingChecks||EMPTY)
    .map(check=>PAYMOB_CHECK_LABEL[check]||check);
  const tenantRollout=(snapshot.tenantRollouts||EMPTY).find(item=>(
    item.tenantId===tenantId&&item.environment===environment
  ));
  const globalReady=(
    environment==='live'&&snapshot.controlledLiveActive===true
  )||snapshot.rolloutMode===environment&&(
    environment==='sandbox'
      ?snapshot.status==='configured'
      :snapshot.status==='active'&&snapshot.active===true
  );
  const liveValidationReady=environment==='live'
    &&snapshot.environment==='live'
    &&snapshot.credentialsEnvironment==='live'
    &&snapshot.status==='configured'
    &&snapshot.rolloutMode==='observe_only'
    &&snapshot.configured===true;

  function openGlobal(targetMode){
    const expected=`ACTIVATE PAYMOB ${targetMode.toUpperCase()}`;
    onAction({
      title:`تفعيل ${targetMode==='live'?'Live':'Sandbox'}`,
      expected,
      request:{action:'global_activate',targetMode},
      successMessage:'تم تنفيذ التفعيل مباشرة بعد تحقق قاعدة البيانات من الصلاحية والأدلة.'
    });
  }
  function disableGlobal(){
    onAction({
      title:'إيقاف بوابة Paymob العامة',
      expected:'DISABLE PAYMOB CHECKOUT',
      request:{action:'global_disable'},
      successMessage:'أوقفت بوابة Paymob العامة فورًا.'
    });
  }
  function openTenant(enabled){
    const tenant=availableTenants.find(item=>item.id===tenantId);
    if(!tenant)return;
    const expected=enabled
      ?`ENABLE PAYMOB TENANT ${tenant.id} ${environment.toUpperCase()}`
      :`DISABLE PAYMOB TENANT ${tenant.id}`;
    onAction({
      title:enabled
        ?`إتاحة Paymob للمنشأة ${tenant.name}`
        :`إيقاف Paymob للمنشأة ${tenant.name}`,
      expected,
      request:{
        action:enabled?'tenant_enable':'tenant_disable',
        tenantId:tenant.id,
        environment
      },
      successMessage:enabled
        ?'تمت إتاحة Paymob للمنشأة مباشرة بعد تحقق جميع البوابات.'
        :'أوقفت إتاحة Paymob للمنشأة.'
    });
  }
  function openEvidence(){
    const digest=artifactSha256.trim().toLowerCase();
    if(!/^[a-f0-9]{64}$/.test(digest))return;
    const expected=`ATTEST PAYMOB EVIDENCE ${evidenceCheck}`;
    onAction({
      title:`تسجيل دليل: ${PAYMOB_CHECK_LABEL[evidenceCheck]}`,
      expected,
      request:{
        action:'evidence_attest',
        checkKey:evidenceCheck,
        artifactSha256:digest
      },
      successMessage:'سُجل واعتمد الدليل ببصمته من المنفّذ المخوّل نفسه.'
    });
  }

  return <section className={styles.governance}>
    <header>
      <div><small>SINGLE AUTHORIZED OPERATOR · AUTOMATIC TENANT ENROLLMENT</small><h2>تشغيل Paymob</h2>
        <p>{snapshot.automaticTenantEnrollment
          ?'Paymob متاح تلقائيًا لكل المنشآت الحالية والجديدة، مع إمكانية إيقافه لمنشأة بعينها وسجل تدقيق كامل. منفّذ واحد يملك الصلاحية يدير الاستثناء مباشرة.'
          :'أي منفّذ يملك صلاحية إدارة الفوترة يستطيع إكمال الإجراء مباشرة. تبقى الأدلة والتأكيد الحرفي وسجل التدقيق إلزامية.'}</p>
      </div>
      <button type="button" onClick={()=>void onRefresh()}>تحديث الجاهزية</button>
    </header>
    <div className={styles.governanceGrid}>
      <article>
        <h3>البوابة العامة</h3>
        <dl>
          <div><dt>الحالة</dt><dd>{STATUS[snapshot.status]||snapshot.status}</dd></div>
          <div><dt>نطاق الإتاحة</dt><dd>{snapshot.rolloutMode}</dd></div>
          <div><dt>Sandbox</dt><dd>{snapshot.sandboxReady?'جاهز':'محجوب'}</dd></div>
          <div><dt>Live</dt><dd>{snapshot.liveReady&&!snapshot.liveGateBlocked?'جاهز':'محجوب'}</dd></div>
          <div><dt>سياسة التنفيذ</dt><dd>منفّذ مخوّل واحد</dd></div>
        </dl>
        {missing.length>0&&<aside className={styles.governanceWarning}>
          <b>أدلة ناقصة</b><span>{missing.join('، ')}</span>
        </aside>}
        <div className={styles.governanceActions}>
          <button type="button" disabled={
            snapshot.environment!=='sandbox'
            ||snapshot.credentialsEnvironment!=='sandbox'
            ||!snapshot.sandboxReady
            ||(snapshot.rolloutMode==='sandbox'&&snapshot.status==='configured')
          } onClick={()=>openGlobal('sandbox')}>تفعيل Sandbox</button>
          <button type="button" disabled={
            !snapshot.liveReady||snapshot.liveGateBlocked
            ||(snapshot.rolloutMode==='live'&&snapshot.status==='active')
          } onClick={()=>openGlobal('live')}>تفعيل Live</button>
          {snapshot.rolloutMode!=='observe_only'&&
            <button type="button" onClick={disableGlobal}>إيقاف بوابة الدفع</button>}
        </div>
        <small className={styles.governanceNote}>التنفيذ مباشر للمستخدم المخوّل، لكن قاعدة البيانات ترفضه ما لم تكتمل جميع أدلة البيئة وعقد الاعتمادات.</small>
      </article>

      <article>
        <h3>إتاحة المنشآت</h3>
        {snapshot.automaticTenantEnrollment&&<aside className={styles.safety}>كل المنشآت الحالية والجديدة تُضاف تلقائيًا إلى Paymob Live. يبقى الإيقاف الفردي متاحًا كاستثناء تشغيلي.</aside>}
        <label>المنشأة<select value={tenantId}
          onChange={event=>setTenantId(event.target.value)}>
          {!availableTenants.length&&<option value="">لا توجد منشآت مؤهلة</option>}
          {availableTenants.map(tenant=><option key={tenant.id} value={tenant.id}>
            {tenant.name}{tenant.slug?` · ${tenant.slug}`:''}
          </option>)}
        </select></label>
        <label>البيئة<select value={environment}
          onChange={event=>setEnvironment(event.target.value)}>
          <option value="sandbox">Sandbox</option><option value="live">Live</option>
        </select></label>
        <dl>
          <div><dt>حالة المنشأة</dt><dd>{tenantRollout?.status||(snapshot.automaticTenantEnrollment?'مفعّلة تلقائيًا':'غير مفعّلة')}</dd></div>
          <div><dt>سياسة التنفيذ</dt><dd>فوري بعد التحقق</dd></div>
        </dl>
        <div className={styles.governanceActions}>
          {tenantRollout?.status!=='enabled'&&<button type="button"
            disabled={!tenantId||(!globalReady&&!liveValidationReady)}
            onClick={()=>openTenant(true)}>إتاحة المنشأة</button>}
          {tenantRollout?.status==='enabled'&&<button type="button"
            onClick={()=>openTenant(false)}>إيقاف المنشأة</button>}
        </div>
        <small className={styles.governanceNote}>الإتاحة التلقائية تشمل كل المنشآت القديمة والجديدة. يمكن إيقاف منشأة محددة يدويًا دون التأثير على بقية المنشآت.</small>
      </article>

      <article>
        <h3>أدلة التشغيل الخارجية</h3>
        <p className={styles.governanceNote}>تُسجّل بصمة SHA-256 لتقرير خارجي محفوظ في نظام الأدلة؛ لا يُرفع التقرير أو أي بيانات عميل هنا.</p>
        <ul className={styles.evidenceList}>
          {PAYMOB_OPERATIONAL_CHECKS.map(check=>{
            const approved=(snapshot.passedChecks||EMPTY).includes(check);
            return <li key={check}><span>{PAYMOB_CHECK_LABEL[check]}</span>
              <b>{approved?'مسجل ومعتمد':'مطلوب'}</b></li>;
          })}
        </ul>
        <label>نوع الدليل<select value={evidenceCheck}
          onChange={event=>{setEvidenceCheck(event.target.value);setArtifactSha256('')}}>
          {PAYMOB_OPERATIONAL_CHECKS.map(check=><option key={check} value={check}>
            {PAYMOB_CHECK_LABEL[check]}
          </option>)}
        </select></label>
        <label>بصمة التقرير SHA-256
          <input value={artifactSha256} dir="ltr" inputMode="text"
            maxLength="64" autoComplete="off" spellCheck="false"
            placeholder="64 lowercase hexadecimal characters"
            onChange={event=>setArtifactSha256(event.target.value.trim().toLowerCase())}/>
        </label>
        <div className={styles.governanceActions}>
          <button type="button"
            disabled={snapshot.environment!=='live'||!/^[a-f0-9]{64}$/.test(artifactSha256)}
            onClick={openEvidence}>تسجيل واعتماد البصمة</button>
        </div>
        <small className={styles.governanceNote}>هذه الواجهة لا تكتب أدلة العمليات الآلية مثل إنشاء الدفع أو Webhook أو المطابقة؛ تلك تُستمد من السجل فقط.</small>
      </article>
    </div>
  </section>;
}

function Providers({rows,onConfigure}){
  return <section className={styles.providers}>{rows.map(item=>{
    const paymob=item.key==='paymob';
    const active=paymob
      ?item.active===true&&item.liveReady===true
        &&item.nativeAdapterDeployed===true
        &&item.liveGateBlocked===false
        &&item.status==='active'&&Boolean(item.verifiedAt)
      :item.status==='active'&&Boolean(item.verifiedAt);
    const configuredSecrets=new Set(item.configuredSecretKeys||EMPTY);
    const missing=providerRequiredSecretKeys(item)
      .filter(key=>!configuredSecrets.has(key));
    const missingChecks=Array.isArray(item.missingChecks)
      ?item.missingChecks.map(check=>PAYMOB_CHECK_LABEL[check]||check)
      :EMPTY;
    const displayStatus=active
      ?'active'
      :item.configured===true||item.status==='active'?'configured':item.status;
    const description=active
      ?'اجتازت بوابة الدفع أدلة التشغيل، وتظل الإتاحة محصورة في المنشآت المسموح لها.'
      :paymob&&item.sandboxReady===true
        ?'Sandbox جاهز، أما الدفع الحي فما زال محجوبًا حتى اكتمال أدلة Webhook والمطابقة والاسترداد.'
        :item.configured===true
          ?'بيانات الاعتماد مكتملة للحفظ والاختبار فقط؛ لا يعني ذلك تفعيل الدفع الحي.'
          :'لا يظهر للمشتري قبل اكتمال الإعداد والتحقق.';
    return <article key={item.key}><header><i>{item.name?.slice(0,2)}</i><Status value={displayStatus}/></header><h2>{item.name}</h2><p>{description}</p><dl><div><dt>بيئة الاعتماد</dt><dd>{item.environment==='live'?'Live':'Sandbox'}</dd></div>{paymob&&<><div><dt>منطقة التشغيل</dt><dd>KSA</dd></div><div><dt>جاهزية Sandbox</dt><dd>{item.sandboxReady===true?'مكتملة':'غير مكتملة'}</dd></div><div><dt>جاهزية Live</dt><dd>{item.liveReady===true&&item.liveGateBlocked===false?'مكتملة':'محجوبة'}</dd></div>{Number.isInteger(item.enabledSandboxTenantCount)&&<div><dt>منشآت Sandbox المسموح لها</dt><dd>{item.enabledSandboxTenantCount}</dd></div>}{Number.isInteger(item.enabledLiveTenantCount)&&<div><dt>منشآت Live المسموح لها</dt><dd>{item.enabledLiveTenantCount}</dd></div>}{missingChecks.length>0&&<div><dt>أدلة التشغيل المتبقية</dt><dd>{missingChecks.join('، ')}</dd></div>}</>}<div><dt>آخر تحقق موثّق</dt><dd>{formatDate(item.verifiedAt)}</dd></div><div><dt>الأسرار الناقصة</dt><dd>{missing.length?missing.map(key=>SECRET_LABEL[key]||key).join('، '):'لا يوجد'}</dd></div></dl><button type="button" onClick={()=>onConfigure(item)}>إدارة الاتصال</button></article>;
  })}{!rows.length&&<Empty/>}</section>;
}

function PaymobControlModal({action,busy,onClose,onSubmit}){
  return <Modal title={action.title} onClose={onClose}>
    <form onSubmit={onSubmit} className={styles.form} autoComplete="off">
      <aside className={styles.safety}>هذا إجراء محمي ومسجّل في سجل التدقيق. يكفي منفّذ واحد يملك الصلاحية، مع بقاء نص التأكيد الحرفي وبوابات قاعدة البيانات إلزامية.</aside>
      <label className={styles.wide}>اكتب نص التأكيد حرفيًا
        <code className={styles.confirmation} dir="ltr">{action.expected}</code>
        <input name="confirmation" dir="ltr" autoComplete="off"
          spellCheck="false" required/>
      </label>
      <footer><button type="button" onClick={onClose}>إلغاء</button>
        <button className={styles.primary} disabled={busy==='paymob-control'}>
          {busy==='paymob-control'?'جارٍ التحقق…':'تنفيذ بعد التحقق'}
        </button>
      </footer>
    </form>
  </Modal>;
}

function PriceModal({item,busy,onClose,onSubmit}){
  const initialFree=item.pricingMode==='free'
    ||(item.pricingConfigured!==false&&item.monthlyAmountMinor===0);
  const [pricingMode,setPricingMode]=useState(initialFree?'free':'fixed');
  const [monthlyAmount,setMonthlyAmount]=useState(
    item.pricingConfigured===false?'':String((Number(item.monthlyAmountMinor)||0)/100)
  );
  if(item.componentOnly)return <Modal title={item.name} onClose={onClose}><p>مكون تشغيلي داخل الإضافة التي تحتاجه، وليس اشتراكًا منفصلًا للبيع.</p><button type="button" onClick={onClose}>إغلاق</button></Modal>;
  if(item.independent){
    const monthlyMinor=pricingMode==='free'
      ?0
      :Math.max(0,Math.round(Number(monthlyAmount||0)*100));
    return <Modal title={`تسعير ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
      <aside className={styles.safety}>السعر الجديد يطبق على الطلبات الجديدة فقط. الطلبات والمدفوعات والتراخيص السابقة لا يعاد تسعيرها.</aside>
      <label>نوع التسعير<select name="pricing_mode" value={pricingMode} onChange={event=>setPricingMode(event.target.value)}>
        <option value="fixed">مدفوعة</option><option value="free">مجانية</option>
      </select></label>
      <label>السعر الشهري بالريال<input name="monthly_amount" type="number" min="0.01" step="0.01" value={pricingMode==='free'?'0':monthlyAmount} onChange={event=>setMonthlyAmount(event.target.value)} disabled={pricingMode==='free'} required={pricingMode==='fixed'}/></label>
      <label>السعر السنوي المحسوب<input value={(monthlyMinor*10/100).toFixed(2)} readOnly dir="ltr"/><small>12 شهرًا بسعر 10 أشهر.</small></label>
      <label>العملة<input value="SAR" readOnly dir="ltr"/></label>
      <label className={styles.wide}>سبب التغيير<input name="reason" minLength="3" maxLength="500" placeholder="مثال: إطلاق الإضافة مجانًا" required/></label>
      {pricingMode==='free'&&<aside className={styles.safety}>ستظهر الإضافة «مجانية» ويستخدم العميل التفعيل الفوري؛ لن ينشئ أودير طلبًا أو محاولة دفع بقيمة صفر.</aside>}
      <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='price'||(pricingMode==='fixed'&&monthlyMinor<1)}>{busy==='price'?'جارٍ الحفظ…':'حفظ التسعير'}</button></footer>
    </form></Modal>;
  }
  return <Modal title={`تسعير ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <label>السعر السنوي بالريال<input name="amount" type="number" min="1" step="1" defaultValue={(Number(item.price?.amountMinor)||0)/100} required/></label>
    <label>العملة<select name="currency" defaultValue={item.price?.currency||'SAR'}><option>SAR</option><option>USD</option></select></label>
    <label>ساري من<input name="valid_from" type="date" min={today()} defaultValue={today()} required/></label>
    <label className={styles.wide}>سبب التغيير<input name="reason" maxLength="500" required/></label>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='price'}>{busy==='price'?'جارٍ الحفظ…':'حفظ نسخة سعر جديدة'}</button></footer>
  </form></Modal>;
}

function ProductModal({item,busy,onClose,onSubmit}){
  const marketplaceVisible=item.marketplaceVisible!==false;
  return <Modal title={`إدارة ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <aside className={styles.productIdentity}><span>المفتاح البرمجي الثابت</span><b dir="ltr">{item.key}</b><small>لا يتغير حتى لا تتأثر التكاملات أو بيانات المنشآت.</small></aside>
    <label>الاسم العربي<input name="name_ar" minLength="2" maxLength="120" defaultValue={item.name||''} required/></label>
    <label>الاسم الإنجليزي<input name="name_en" dir="ltr" maxLength="120" defaultValue={item.nameEn||''}/></label>
    <label className={styles.wide}>وصف بطاقة المتجر<textarea name="description_ar" minLength="10" maxLength="1000" defaultValue={item.description||''} required/></label>
    <label>شارة العرض <small>اختياري: مثل «الأكثر طلبًا»</small><input name="badge_ar" maxLength="60" defaultValue={item.badge||''}/></label>
    <label>ترتيب الظهور<input name="display_order" type="number" min="0" max="10000" defaultValue={item.displayOrder??100} required/></label>
    <label className={`${styles.check} ${styles.visibilityCheck}`}><input name="marketplace_visible" type="checkbox" defaultChecked={marketplaceVisible}/><span><b>إظهار الإضافة في متجر المنشآت</b><small>إلغاء الاختيار يخفيها ويمنع طلبات وتفعيلات جديدة فقط.</small></span></label>
    <aside className={styles.safety}>الإخفاء لا يوقف الإضافة لدى أي منشأة مشتركة، ولا يلغي ترخيصًا، ولا يحذف إعدادات أو بيانات. يمكنك أيضًا منح الإضافة يدويًا وهي مخفية.</aside>
    <label className={styles.wide}>سبب التعديل<input name="reason" minLength="3" maxLength="500" placeholder="مثال: تحديث الاسم وإيقاف البيع مؤقتًا" required/></label>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='product'}>{busy==='product'?'جارٍ الحفظ…':'حفظ معلومات الإضافة'}</button></footer>
  </form></Modal>;
}

function GrantModal({products,tenants,busy,onClose,onSubmit}){
  const start=today();
  const end=annualEnd(start);
  return <Modal title="منح ترخيص مؤرخ" onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <label>المنشأة<select name="tenant_id" required defaultValue=""><option value="" disabled>اختر المنشأة بالاسم والرابط</option>{tenants.map(tenant=><option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.slug}</option>)}</select></label>
    <label>الإضافة<select name="product_key" required>{products.map(item=><option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
    <label>تاريخ البداية<input name="starts_at" type="date" defaultValue={start} required/></label>
    <label>تاريخ النهاية<input name="ends_at" type="date" defaultValue={end} required/></label>
    <label className={styles.wide}>سبب المنحة<input name="reason" maxLength="500" required/></label>
    <aside className={styles.safety}>إيقاف الترخيص لاحقًا يمنع الوصول فقط؛ لا يحذف بيانات الإضافة.</aside>
    <label className={styles.check}><input type="checkbox" required/><span>أؤكد اسم المنشأة والإضافة وفترة الترخيص الظاهرة أعلاه.</span></label>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='grant'||!tenants.length}>{busy==='grant'?'جارٍ المنح…':'منح الترخيص'}</button></footer>
  </form></Modal>;
}

function CategoryModal({item,busy,onClose,onSubmit}){
  return <Modal title={item?'تعديل قسم الإضافات':'قسم إضافات جديد'} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <label>مفتاح القسم<input name="key" pattern="[a-z][a-z0-9_]{2,60}" defaultValue={item?.key||''} disabled={Boolean(item)} required/></label>
    <label>اسم القسم<input name="name" defaultValue={item?.name||''} required/></label>
    <label>رمز الأيقونة<input name="icon_key" defaultValue={item?.iconKey||'addon'}/></label>
    <label>ترتيب العرض<input name="display_order" type="number" defaultValue="100"/></label>
    <label className={styles.wide}>الوصف<textarea name="description" defaultValue={item?.description||''}/></label>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='category'}>حفظ القسم</button></footer>
  </form></Modal>;
}

function AssignCategoryModal({item,categories,busy,onClose,onSubmit}){
  return <Modal title={`تصنيف ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <label className={styles.wide}>قسم الإضافة<select name="category_id" defaultValue={item.categoryId||categories[0]?.id||''} required>{categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
    <aside className={styles.safety}>التصنيف يغيّر مكان العرض في المتجر فقط، ولا يؤثر على تراخيص المنشآت أو بيانات الإضافة.</aside>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='assign-category'||!categories.length}>حفظ التصنيف</button></footer>
  </form></Modal>;
}

function ProviderModal({item,busy,onClose,onSubmit}){
  if(item.key==='tamara')return <Modal title="إعداد تمارا" onClose={onClose}>
    <TamaraSetupForm item={item} busy={busy} onClose={onClose} onSubmit={onSubmit}/>
  </Modal>;
  return <GenericProviderModal item={item} busy={busy} onClose={onClose} onSubmit={onSubmit}/>;
}

function GenericProviderModal({item,busy,onClose,onSubmit}){
  const configured=new Set(item.configuredSecretKeys||EMPTY);
  const requiredSecrets=new Set(providerRequiredSecretKeys(item));
  const publicConfig=item.configuredPublicConfig||{};
  const publicConfigKeys=providerPublicConfigKeys(item);
  const publicConfigKeySet=new Set(publicConfigKeys);
  const secretKeys=providerSecretKeys(item)
    .filter(secretKey=>!publicConfigKeySet.has(secretKey));
  const initialEnvironment=item.environment||'sandbox';
  const [environment,setEnvironment]=useState(initialEnvironment);
  const environmentChanged=environment!==initialEnvironment;
  const paymob=item.key==='paymob';
  const integrationPath=paymob?'quicklink':'';
  const visiblePublicConfigKeys=publicConfigKeys.filter(configKey=>(
    configKey!=='integrationPath'
    &&(configKey!=='applePayIntegrationId'||integrationPath==='quicklink')
  ));
  return <Modal title={`إدارة ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form} autoComplete="off">
    <label>بيئة الاعتماد<select name="environment" value={environment} onChange={event=>setEnvironment(event.target.value)}><option value="sandbox">Sandbox</option><option value="live">Live credentials</option></select></label>
    <label>طريقة Checkout{paymob?<select name="checkout_mode" value="redirect" disabled><option value="redirect">Paymob Hosted Redirect</option></select>:<select name="checkout_mode" defaultValue={item.checkoutMode||'redirect'}><option value="redirect">Redirect</option><option value="embedded">Embedded</option><option value="api">API</option></select>}</label>
    <label className={styles.wide}>العملات{paymob?<input name="currencies" value="SAR" readOnly/>:<input name="currencies" defaultValue={(item.supportedCurrencies||['SAR']).join(', ')}/>} {paymob&&<small>مسار KSA في هذا الإصدار يقبل SAR فقط.</small>}</label>
    {paymob&&<aside className={`${styles.safety} ${styles.wide}`}>
      <b>Paymob Hosted Redirect</b><br/>
      مسار دفع واحد ثابت وآمن: ينشئ أودير رابط Paymob ثم يحوّل العميل إليه. يحتاج API Key وHMAC فقط، مع Integration ID للبطاقات/مدى وApple Pay اختياري.
    </aside>}
    {visiblePublicConfigKeys.map(configKey=>{const fixedRegion=paymob&&configKey==='region';const numericPaymobId=paymob&&['merchantAccountId','integrationId','applePayIntegrationId'].includes(configKey);const optionalApple=paymob&&configKey==='applePayIntegrationId';const contextualLabel=paymob&&configKey==='integrationId'&&integrationPath==='quicklink'?'Integration ID للبطاقات/مدى':PUBLIC_CONFIG_LABEL[configKey]||configKey;return <label key={`${configKey}-${environment}`} className={styles.wide}>{contextualLabel}<small>{fixedRegion?'مثبتة خادميًا على المملكة العربية السعودية':optionalApple?'اختياري؛ اتركه فارغًا لإخفاء Apple Pay عن العميل':environmentChanged?'تغيرت البيئة — أدخل المعرّف الخاص بهذه البيئة':'بيان عام للربط وليس مفتاحًا سريًا'}</small>{fixedRegion?<input name={`public_${configKey}`} value="ksa" readOnly maxLength="240" dir="ltr" required/>:<input name={`public_${configKey}`} defaultValue={environmentChanged?'':publicConfig[configKey]||''} inputMode={numericPaymobId?'numeric':undefined} pattern={numericPaymobId?'[1-9][0-9]*':undefined} maxLength="240" dir={numericPaymobId?'ltr':undefined} required={!optionalApple}/>}</label>})}
    {secretKeys.map(secretKey=>{const mustReplace=environmentChanged&&(requiredSecrets.has(secretKey)||configured.has(secretKey));const required=mustReplace||(!configured.has(secretKey)&&requiredSecrets.has(secretKey));return <label key={`${secretKey}-${environment}`} className={styles.wide}>{SECRET_LABEL[secretKey]||secretKey}{configured.has(secretKey)&&<small>{mustReplace?'تغيرت البيئة — أدخل قيمة جديدة لهذه البيئة':'محفوظ في Vault — اتركه فارغًا للإبقاء عليه'}</small>}<input name={`secret_${secretKey}`} type="password" autoComplete="new-password" placeholder={configured.has(secretKey)&&!mustReplace?'••••••••':'أدخل القيمة السرية'} required={required}/></label>})}
    <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={item.status!=='disabled'}/><span>إتاحة الإعداد للاختبار</span></label>
    <aside className={styles.safety}>{paymob?'تغيير Integration ID يعيد الجاهزية إلى المراجعة ويُمنع مع وجود محاولة دفع مفتوحة. لا تُعرض المفاتيح بعد الحفظ، ويظل Webhook الموقّع هو مصدر حقيقة السداد والتفعيل.':'لا تُعرض الأسرار بعد الحفظ. ولا تتحول الحالة إلى «نشط» إلا من أدلة تشغيل خادمية موثّقة.'}</aside>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='provider'}>{busy==='provider'?'جارٍ الحفظ…':'حفظ آمن'}</button></footer>
  </form></Modal>;
}

function Modal({title,onClose,children}){
  const titleId=useId();
  const modalRef=useRef(null);
  const closeRef=useRef(null);
  useEffect(()=>{
    const opener=document.activeElement;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    closeRef.current?.focus();
    function keyboard(event){
      if(event.key==='Escape'){event.preventDefault();onClose();return;}
      if(event.key!=='Tab'||!modalRef.current)return;
      const focusable=[...modalRef.current.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )];
      if(!focusable.length)return;
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',keyboard);
    return ()=>{
      document.removeEventListener('keydown',keyboard);
      document.body.style.overflow=previousOverflow;
      if(opener instanceof HTMLElement)opener.focus();
    };
  },[onClose]);
  return <div className={styles.modalLayer}><button type="button" className={styles.backdrop} tabIndex="-1" aria-label="إغلاق" onClick={onClose}/><section ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><button ref={closeRef} type="button" aria-label="إغلاق" onClick={onClose}>×</button></header>{children}</section></div>;
}
function Status({value}){return <span className={`${styles.status} ${styles[value]||''}`}>{STATUS[value]||value||'غير محدد'}</span>}
function Empty(){return <div className={styles.empty}>لا توجد سجلات مطابقة.</div>}
