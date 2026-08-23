'use client';

import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-addon-console.module.css';

const EMPTY=[];
const TABS=[
  ['catalog','كتالوج الإضافات'],
  ['categories','أقسام الإضافات'],
  ['licenses','تراخيص المنشآت']
];
const STATUS={
  pending:'بانتظار القرار',trialing:'تجريبية',active:'نشطة',paused:'موقوفة',
  cancelled:'ملغاة',expired:'منتهية',draft:'مسودة',configured:'جاهزة للاختبار',
  disabled:'معطلة',error:'خطأ اتصال'
};
const PUBLIC_CONFIG_LABEL={
  merchantId:'معرّف التاجر',merchantAccountId:'معرّف حساب التاجر',
  integrationId:'معرّف التكامل',webhookId:'معرّف Webhook'
};
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
  const closeModal=useCallback(()=>setModal(null),[setModal]);
  const products=data.products||EMPTY;
  const subscriptions=data.subscriptions||EMPTY;
  const categories=data.addonCategories||EMPTY;
  const providers=data.paymentProviders||EMPTY;
  const tenants=data.tenants||EMPTY;
  const summary=data.summary||{};

  const filtered=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    const source=tab==='catalog'?products:tab==='licenses'?subscriptions:tab==='providers'?providers:categories;
    return source.filter(item=>!needle||[
      item.name,item.key,item.productName,item.productKey,
      item.tenantName,item.tenantSlug,item.status,item.categoryName
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
    try{
      await platformAction('set_annual_price',{
        productKey:modal.item.key,
        amountMinor:Math.round(Number(values.amount||0)*100),
        currency:values.currency,
        validFrom:values.valid_from,
        taxRateBps:1500,
        reason:values.reason
      });
      setModal(null);
      setNotice('تمت إضافة نسخة سعر سنوية جديدة دون تغيير الأسعار التاريخية.');
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
      for(const secretKey of [...(provider.requiredSecretKeys||EMPTY),...(provider.optionalSecretKeys||EMPTY)]){
        const secretValue=String(form.get(`secret_${secretKey}`)||'').trim();
        if(secretValue)secrets[secretKey]=secretValue;
      }
      const publicConfig={};
      for(const configKey of provider.requiredPublicConfigKeys||EMPTY){
        const configValue=String(form.get(`public_${configKey}`)||'').trim();
        if(configValue)publicConfig[configKey]=configValue;
      }
      const response=await fetch('/api/platform/payment-provider-secret',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          providerKey:provider.key,environment:form.get('environment'),
          checkoutMode:form.get('checkout_mode'),
          supportedCurrencies:String(form.get('currencies')||'').split(',').map(value=>value.trim().toUpperCase()).filter(Boolean),
          enabled:form.get('enabled')==='on',publicConfig,secrets
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر حفظ الاتصال');
      setModal(null);setNotice('حُفظ الإعداد. سيظل المزود غير نشط حتى ينجح اختبار Adapter وWebhook فعلي.');router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
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
      <article><span>الإضافات المنشورة</span><b>{summary.publishedProducts??summary.products??0}</b><small>بعقد إصدار مستقل</small></article>
      <article><span>التراخيص النشطة</span><b>{summary.activeLicenses||0}</b><small>مع فحص تاريخ الانتهاء</small></article>
      <article><span>أقسام الإضافات</span><b>{categories.length}</b><small>تصنيف مستقل وواضح</small></article>
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
      {tab==='catalog'&&<Catalog rows={filtered} onPrice={item=>setModal({type:'price',item})} onCategory={item=>setModal({type:'assign-category',item})}/>} 
      {tab==='categories'&&<Categories rows={filtered} onEdit={item=>setModal({type:'category',item})}/>} 
      {tab==='licenses'&&<Licenses rows={filtered} busy={busy} onDecision={decide} onStatus={setLicenseStatus}/>} 
      {tab==='providers'&&<Providers rows={filtered} onConfigure={item=>setModal({type:'provider',item})}/>} 
    </section>

    {modal?.type==='price'&&<PriceModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={savePrice}/>} 
    {modal?.type==='grant'&&<GrantModal products={products} tenants={tenants} busy={busy} onClose={closeModal} onSubmit={grantLicense}/>} 
    {modal?.type==='category'&&<CategoryModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={saveCategory}/>} 
    {modal?.type==='assign-category'&&<AssignCategoryModal item={modal.item} categories={categories} busy={busy} onClose={closeModal} onSubmit={assignCategory}/>} 
    {modal?.type==='provider'&&<ProviderModal item={modal.item} busy={busy} onClose={closeModal} onSubmit={saveProvider}/>} 
  </section>;
}

function Catalog({rows,onPrice,onCategory}){
  return <div className={styles.table}>
    <header><span>الإضافة</span><span>القسم</span><span>السعر السنوي</span><span>الإصدار والظهور</span><span>الحالة</span><span/></header>
    {rows.map(item=>{
      const price=item.price||{};
      const activeMedia=(item.media||EMPTY).filter(media=>media.status==='active').length;
      return <article key={item.id||item.key}>
        <div><b>{item.name}</b><small>{item.key}</small></div>
        <div><b>{item.categoryName||'غير مصنفة'}</b><small>{item.surfaces?.length||0} موضع ظهور</small></div>
        <div><b>{money(price.amountMinor,price.currency)}</b><small>من {formatDate(price.validFrom)}</small></div>
        <div><b>{item.manifest?.version||'—'}</b><small>{activeMedia} صور معتمدة · {item.media?.length||0} خانات</small></div>
        <Status value={item.manifest?.status||item.status}/>
        <div className={styles.actions}><button type="button" onClick={()=>onCategory(item)}>تصنيف</button><button type="button" onClick={()=>onPrice(item)}>تسعير</button></div>
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

function Providers({rows,onConfigure}){
  return <section className={styles.providers}>{rows.map(item=>{
    const active=item.status==='active'&&item.verifiedAt;
    const configured=new Set(item.configuredSecretKeys||EMPTY);
    const missing=(item.requiredSecretKeys||EMPTY).filter(key=>!configured.has(key));
    return <article key={item.key}><header><i>{item.name?.slice(0,2)}</i><Status value={active?'active':item.status}/></header><h2>{item.name}</h2><p>{active?'تم التحقق الفعلي ويمكن عرضه للمشتري.':item.status==='configured'?'الأسرار مكتملة، ويلزم اختبار Adapter وWebhook.':'لا يظهر للمشتري قبل اكتمال الإعداد والتحقق.'}</p><dl><div><dt>البيئة</dt><dd>{item.environment==='live'?'Live':'Sandbox'}</dd></div><div><dt>آخر تحقق</dt><dd>{formatDate(item.verifiedAt)}</dd></div><div><dt>الأسرار الناقصة</dt><dd>{missing.length?missing.join('، '):'لا يوجد'}</dd></div></dl><button type="button" onClick={()=>onConfigure(item)}>إدارة الاتصال</button></article>;
  })}{!rows.length&&<Empty/>}</section>;
}

function PriceModal({item,busy,onClose,onSubmit}){
  return <Modal title={`تسعير ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form}>
    <label>السعر السنوي بالريال<input name="amount" type="number" min="1" step="1" defaultValue={(Number(item.price?.amountMinor)||0)/100} required/></label>
    <label>العملة<select name="currency" defaultValue={item.price?.currency||'SAR'}><option>SAR</option><option>USD</option></select></label>
    <label>ساري من<input name="valid_from" type="date" min={today()} defaultValue={today()} required/></label>
    <label className={styles.wide}>سبب التغيير<input name="reason" maxLength="500" required/></label>
    <footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.primary} disabled={busy==='price'}>{busy==='price'?'جارٍ الحفظ…':'حفظ نسخة سعر جديدة'}</button></footer>
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
  const configured=new Set(item.configuredSecretKeys||EMPTY);
  const requiredSecrets=new Set(item.requiredSecretKeys||EMPTY);
  const publicConfig=item.configuredPublicConfig||{};
  const publicConfigKeys=item.requiredPublicConfigKeys||EMPTY;
  const publicConfigKeySet=new Set(publicConfigKeys);
  const secretKeys=[...(item.requiredSecretKeys||EMPTY),...(item.optionalSecretKeys||EMPTY)]
    .filter(secretKey=>!publicConfigKeySet.has(secretKey));
  const initialEnvironment=item.environment||'sandbox';
  const [environment,setEnvironment]=useState(initialEnvironment);
  const environmentChanged=environment!==initialEnvironment;
  return <Modal title={`إدارة ${item.name}`} onClose={onClose}><form onSubmit={onSubmit} className={styles.form} autoComplete="off">
    <label>البيئة<select name="environment" value={environment} onChange={event=>setEnvironment(event.target.value)}><option value="sandbox">Sandbox</option><option value="live">Live</option></select></label>
    <label>طريقة Checkout<select name="checkout_mode" defaultValue={item.checkoutMode||'redirect'}><option value="redirect">Redirect</option><option value="embedded">Embedded</option><option value="api">API</option></select></label>
    <label className={styles.wide}>العملات<input name="currencies" defaultValue={(item.supportedCurrencies||['SAR']).join(', ')}/></label>
    {publicConfigKeys.map(configKey=><label key={`${configKey}-${environment}`} className={styles.wide}>{PUBLIC_CONFIG_LABEL[configKey]||configKey}<small>{environmentChanged?'تغيرت البيئة — أدخل المعرّف الخاص بهذه البيئة':'بيان عام للربط وليس مفتاحًا سريًا'}</small><input name={`public_${configKey}`} defaultValue={environmentChanged?'':publicConfig[configKey]||''} maxLength="240" required/></label>)}
    {secretKeys.map(secretKey=>{const mustReplace=environmentChanged&&(requiredSecrets.has(secretKey)||configured.has(secretKey));const required=mustReplace||(!configured.has(secretKey)&&requiredSecrets.has(secretKey));return <label key={`${secretKey}-${environment}`} className={styles.wide}>{secretKey}{configured.has(secretKey)&&<small>{mustReplace?'تغيرت البيئة — أدخل قيمة جديدة لهذه البيئة':'محفوظ في Vault — اتركه فارغًا للإبقاء عليه'}</small>}<input name={`secret_${secretKey}`} type="password" autoComplete="new-password" placeholder={configured.has(secretKey)&&!mustReplace?'••••••••':'أدخل القيمة السرية'} required={required}/></label>})}
    <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={item.status!=='disabled'}/><span>إتاحة الإعداد للاختبار</span></label>
    <aside className={styles.safety}>لا تُعرض الأسرار بعد الحفظ. ولا تتحول الحالة إلى «نشط» إلا من اختبار خادمي ناجح وموقّع.</aside>
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
