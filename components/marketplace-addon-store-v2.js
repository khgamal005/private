'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './marketplace-store.module.css';

const EMPTY=[];
const STATUS={
  pending_payment:'بانتظار الدفع',
  paid:'تم الدفع',
  in_progress:'قيد التنفيذ',
  completed:'مكتمل',
  cancelled:'ملغي',
  refunded:'مسترد'
};
const TRANSFER_STATUS={
  pending:'بانتظار المراجعة',
  reviewing:'قيد المراجعة',
  approved:'تم الاعتماد',
  rejected:'مرفوض',
  cancelled:'ملغي'
};
const PAYMENT_PROVIDER_NAMES={
  bank_transfer:'تحويل بنكي',
  paymob:'دفع إلكتروني عبر Paymob',
  tamara:'تمارا',
  paypal:'PayPal'
};
const ADDON_CATEGORIES={
  all:'كل الإضافات',
  communications:'التواصل',
  commerce:'المتاجر',
  automation:'الأتمتة',
  marketing:'التسويق',
  telephony:'الاتصالات',
  website:'الموقع',
  training:'التدريب',
  integrations:'التكاملات والمتاجر',
  websites:'المواقع والمحتوى',
  analytics:'التحليلات والقياس'
};
const ADDON_LINKS={
  yeastar:'yeastar',
  cms_pro:'website',
  marketing_attribution:'marketing',
  woocommerce:'integrations',
  salla:'integrations',
  zid:'integrations',
  shopify:'integrations',
  custom_store:'integrations',
  lms:'lms'
};

function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency,maximumFractionDigits:2
  }).format((Number(amountMinor)||0)/100);
}
function formatDate(value){
  if(!value)return '—';
  return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
}
function requestKey(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  return 'marketplace-'+Date.now()+'-'+Math.random().toString(36).slice(2);
}
function itemProductKey(order){return order?.items?.[0]?.productKey||'';}
function paymentProviderName(providerKey,paymentMethods){
  return paymentMethods.find(item=>item.key===providerKey)?.name
    ||PAYMENT_PROVIDER_NAMES[providerKey]
    ||'غير محددة';
}
function today(){
  const now=new Date();
  const offset=now.getTimezoneOffset();
  return new Date(now.getTime()-offset*60000).toISOString().slice(0,10);
}

export default function MarketplaceAddonStoreV2({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const addons=data.addons||EMPTY;
  const addonCategories=data.addonCategories||EMPTY;
  const orders=data.orders||EMPTY;
  const paymentMethods=data.paymentMethods||EMPTY;
  const transfers=data.bankTransferSubmissions||EMPTY;
  const canPurchase=Boolean(data.viewer?.canPurchase);
  const [query,setQuery]=useState('');
  const [category,setCategory]=useState('all');
  const [checkout,setCheckout]=useState(null);
  const [paymentProvider,setPaymentProvider]=useState(paymentMethods[0]?.key||'bank_transfer');
  const [notes,setNotes]=useState('');
  const [transferOrder,setTransferOrder]=useState(null);
  const [senderName,setSenderName]=useState('');
  const [transferReference,setTransferReference]=useState('');
  const [transferDate,setTransferDate]=useState(today());
  const [paymobOrder,setPaymobOrder]=useState(null);
  const [billingFirstName,setBillingFirstName]=useState('');
  const [billingLastName,setBillingLastName]=useState('');
  const [billingEmail,setBillingEmail]=useState('');
  const [billingPhone,setBillingPhone]=useState('');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  const transferByOrder=useMemo(()=>new Map(transfers.map(item=>[item.orderId,item])),[transfers]);
  const categoryOptions=useMemo(()=>{
    const result=[{key:'all',name:'كل الإضافات'}];
    const seen=new Set(['all']);
    for(const item of addonCategories){
      const key=String(item.key||'').trim();
      if(!key||seen.has(key))continue;
      seen.add(key);result.push({key,name:item.name||ADDON_CATEGORIES[key]||key});
    }
    for(const item of addons){
      const key=String(item.categoryKey||'').trim();
      if(!key||seen.has(key))continue;
      seen.add(key);result.push({key,name:item.categoryName||ADDON_CATEGORIES[key]||'إضافات أخرى'});
    }
    return result;
  },[addonCategories,addons]);
  const filtered=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return addons.filter(item=>(category==='all'||item.categoryKey===category)
      &&(!needle||[item.name,item.description,item.badge].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle))));
  },[addons,category,query]);

  async function action(p_action,p_payload){
    const response=await fetch('/api/tenant/marketplace-v2',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({p_slug:slug,p_action,p_payload})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data||{};
  }

  async function activateFree(item){
    if(busy)return;
    setBusy('free-'+item.key);setError('');setNotice('');
    try{
      const result=await action('activate_free_addon',{productKey:item.key});
      setNotice(result.status==='already_active'?'الإضافة مفعلة بالفعل.':'تم تفعيل الإضافة المجانية فورًا لهذه المنشأة.');
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر تفعيل الإضافة');}
    finally{setBusy('');}
  }

  function openCheckout(item){
    setCheckout({
      item,
      requestKey:requestKey(),
      paymentRequestKey:requestKey()
    });
    setPaymentProvider(paymentMethods[0]?.key||'bank_transfer');
    resetBillingContact();
    setNotes('');setError('');setNotice('');
  }

  function resetBillingContact(){
    setBillingFirstName('');setBillingLastName('');
    setBillingEmail('');setBillingPhone('');
  }

  function billingContact(){
    return {
      firstName:billingFirstName.trim(),
      lastName:billingLastName.trim(),
      email:billingEmail.trim(),
      phoneNumber:billingPhone.trim()
    };
  }

  async function redirectToPaymob(order,paymentRequestKey){
    const response=await fetch('/api/payments/paymob/checkout',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        slug,
        orderId:order.id,
        idempotencyKey:paymentRequestKey,
        billingContact:billingContact()
      })
    });
    const result=await response.json().catch(()=>({}));
    if(response.status===202&&result.attemptId){
      const returnUrl='/tenant/'+encodeURIComponent(slug)
        +'/payments/paymob/return?attempt='
        +encodeURIComponent(result.attemptId);
      router.push(returnUrl);
      return true;
    }
    if(!response.ok){
      throw new Error(result.error||'تعذر فتح صفحة الدفع الآمنة');
    }
    const checkoutUrl=String(result.checkoutUrl||'');
    if(!checkoutUrl)throw new Error('لم تُرجع بوابة الدفع رابطًا صالحًا');
    window.location.assign(checkoutUrl);
    return true;
  }

  async function createOrder(event){
    event.preventDefault();
    if(!checkout||busy)return;
    setBusy('checkout');setError('');setNotice('');
    let order=null;
    let navigating=false;
    try{
      order=await action('create_order',{
        itemType:'addon',productKey:checkout.item.key,quantity:1,notes,
        idempotencyKey:checkout.requestKey,paymentProvider
      });
      setCheckout(null);
      if(order.paymentProvider==='bank_transfer'){
        setTransferOrder(order);
        setSenderName('');setTransferReference('');setTransferDate(today());
        setNotice('تم إنشاء الطلب '+(order.orderNumber||'')+'. أدخل بيانات التحويل لإرساله إلى المراجعة.');
        router.refresh();
      }else if(order.paymentProvider==='paymob'){
        navigating=await redirectToPaymob(order,checkout.paymentRequestKey);
      }else{
        setNotice('تم إنشاء طلب الشراء '+(order.orderNumber||'')+'.');
        router.refresh();
      }
    }catch(err){
      if(order?.id){
        setCheckout(null);
        setError('تم حفظ الطلب، لكن '+(err instanceof Error?err.message:'تعذر فتح صفحة الدفع')+'. يمكنك استكمال الدفع من سجل الطلبات.');
        router.refresh();
      }else{
        setError(err instanceof Error?err.message:'تعذر إنشاء الطلب');
      }
    }finally{if(!navigating)setBusy('');}
  }

  function openTransfer(order){
    setTransferOrder(order);setSenderName('');setTransferReference('');setTransferDate(today());setError('');setNotice('');
  }

  function openPaymob(order){
    setPaymobOrder({order,paymentRequestKey:requestKey()});
    resetBillingContact();setError('');setNotice('');
  }

  async function continuePaymob(event){
    event.preventDefault();
    if(!paymobOrder||busy)return;
    setBusy('paymob-'+paymobOrder.order.id);setError('');setNotice('');
    let navigating=false;
    try{
      navigating=await redirectToPaymob(
        paymobOrder.order,
        paymobOrder.paymentRequestKey
      );
    }catch(err){
      setPaymobOrder(null);
      setError(err instanceof Error?err.message:'تعذر فتح صفحة الدفع الآمنة');
      router.refresh();
    }finally{if(!navigating)setBusy('');}
  }

  async function submitTransfer(event){
    event.preventDefault();
    if(!transferOrder||busy)return;
    setBusy('transfer');setError('');setNotice('');
    try{
      await action('submit_bank_transfer',{
        orderId:transferOrder.id,senderName,transferReference,transferDate
      });
      setTransferOrder(null);
      setNotice('تم إرسال بيانات التحويل للمراجعة. لن تُفعّل الإضافة قبل مراجعته واعتماده من إدارة المنصة.');
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر إرسال بيانات التحويل');}
    finally{setBusy('');}
  }

  async function cancelOrder(order){
    if(busy)return;
    if(order?.paymentProvider==='paymob'){
      setError('لا يمكن إلغاء طلب Paymob قبل حسم حالة العملية. استكمل نفس الدفع أو تابع المطابقة، وتواصل مع الدعم برقم الطلب إذا استمر التعليق.');
      return;
    }
    const orderId=order?.id;
    if(!orderId)return;
    setBusy('cancel-'+orderId);setError('');setNotice('');
    try{
      await action('cancel_order',{orderId});
      setNotice('تم إلغاء طلب الشراء المعلق.');router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر إلغاء الطلب');}
    finally{setBusy('');}
  }

  const subtotal=Number(checkout?.item?.amountMinor||0);
  const tax=Math.round(subtotal*.15);
  const selectedMethod=paymentMethods.find(item=>item.key===paymentProvider);
  const bankConfig=paymentMethods.find(item=>item.key==='bank_transfer')?.publicConfig||{};

  return <section className={styles.store}>
    <header className={styles.hero}>
      <div>
        <span>أودير من ماركتون</span>
        <h1>متجر الإضافات</h1>
        <p>النسخة الأساسية تعمل مستقلة. فعّل الإضافات المجانية فورًا، أو اشترك سنويًا في الإضافات المدفوعة التي تحتاجها فقط.</p>
      </div>
      <aside>
        <b>اشتراكات واضحة ومستقلة</b>
        <small>التحويل البنكي لا يفعّل أي إضافة قبل مراجعته واعتماده من إدارة المنصة.</small>
      </aside>
    </header>

    <section className={styles.kpis}>
      <article><span>إضافات متاحة</span><b>{data.summary?.addonProducts||addons.length}</b><small>مجانية ومدفوعة</small></article>
      <article><span>إضافات مجانية</span><b>{data.summary?.freeAddonProducts||0}</b><small>تفعيل فوري</small></article>
      <article><span>إضافاتك النشطة</span><b>{data.summary?.activeAddons||0}</b><small>مرتبطة بهذه المنشأة</small></article>
      <article><span>طلبات مفتوحة</span><b>{data.summary?.openOrders||0}</b><small>بانتظار دفع أو مراجعة</small></article>
    </section>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {!canPurchase&&<div className={styles.info}>يمكنك استعراض الإضافات، والتفعيل أو الشراء متاح لمالك المنشأة أو من لديه صلاحية إدارة الاشتراك.</div>}

    <section className={styles.filters}>
      <label><span aria-hidden="true">⌕</span><input aria-label="البحث في الإضافات" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث في الإضافات…"/></label>
      <div>{categoryOptions.map(item=><button type="button" key={item.key} className={category===item.key?styles.selected:''} onClick={()=>setCategory(item.key)}>{item.name}</button>)}</div>
    </section>

    <section className={styles.grid}>
      {filtered.map(item=><AddonCard key={item.id} slug={slug} item={item} canPurchase={canPurchase}
        pending={orders.some(order=>order.status==='pending_payment'&&itemProductKey(order)===item.key)}
        busy={busy} onActivateFree={()=>activateFree(item)} onBuy={()=>openCheckout(item)}/>)}
      {!filtered.length&&<div className={styles.empty}><span>⌕</span><h2>لا توجد نتائج مطابقة</h2><p>جرّب قسمًا آخر أو غيّر عبارة البحث.</p></div>}
    </section>

    <section className={styles.orders}>
      <header><div><small>سجل منشأتك</small><h2>طلبات الإضافات الأخيرة</h2></div><span>{orders.length} طلب</span></header>
      <div className={styles.orderList}>
        {orders.filter(order=>order.kind==='addon').map(order=>{
          const transfer=transferByOrder.get(order.id);
          return <article key={order.id}>
            <div className={styles.orderIdentity}><b>{order.orderNumber}</b><small>{order.items?.map(item=>item.name).join('، ')||'إضافة أودير'}</small></div>
            <span className={[styles.status,styles[order.status]||''].join(' ')}>{STATUS[order.status]||order.status}</span>
            <div><small>الإجمالي</small><b>{money(order.totalMinor,order.currency)}</b></div>
            <div><small>الدفع</small><b>{paymentProviderName(order.paymentProvider,paymentMethods)}</b>{transfer&&<small>{TRANSFER_STATUS[transfer.status]||transfer.status}</small>}{order.status==='pending_payment'&&order.paymentProvider==='paymob'&&<small className={styles.paymobOrderGuard}>استكمل نفس العملية أو تابع المطابقة؛ لا تبدأ دفعة أخرى. تواصل مع الدعم برقم الطلب إذا استمر التعليق.</small>}</div>
            {order.status==='pending_payment'&&order.paymentProvider==='bank_transfer'&&(!transfer||transfer.status==='rejected')&&<button type="button" disabled={Boolean(busy)} onClick={()=>openTransfer(order)}>إرسال بيانات التحويل</button>}
            {order.status==='pending_payment'&&order.paymentProvider==='paymob'&&<button type="button" className={styles.payButton} disabled={Boolean(busy)} onClick={()=>openPaymob(order)}>{busy==='paymob-'+order.id?'جارٍ فتح الدفع…':'استكمال الدفع'}</button>}
            {order.status==='pending_payment'&&order.paymentProvider!=='paymob'&&<button type="button" className={styles.cancel} disabled={Boolean(busy)} onClick={()=>cancelOrder(order)}>{busy==='cancel-'+order.id?'جارٍ الإلغاء…':'إلغاء'}</button>}
          </article>;
        })}
        {!orders.some(order=>order.kind==='addon')&&<div className={styles.emptyOrders}>لا توجد طلبات إضافات حتى الآن.</div>}
      </div>
    </section>

    {checkout&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} aria-label="إغلاق" onClick={()=>setCheckout(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" onSubmit={createOrder}>
        <header><div><small>اشتراك إضافة سنوي</small><h2>{checkout.item.name}</h2></div><button type="button" onClick={()=>setCheckout(null)} aria-label="إغلاق">×</button></header>
        <p>{checkout.item.description}</p>
        <label><span>وسيلة الدفع</span><select value={paymentProvider} onChange={event=>setPaymentProvider(event.target.value)} required>
          {paymentMethods.map(method=><option key={method.key} value={method.key}>{method.name}</option>)}
        </select></label>
        {selectedMethod?.publicConfig?.instructionsAr&&<div className={styles.activationNote}><span>↔</span><p>{selectedMethod.publicConfig.instructionsAr}</p></div>}
        {selectedMethod?.key==='bank_transfer'&&(selectedMethod.publicConfig?.bankName||selectedMethod.publicConfig?.iban)&&<div className={styles.info}>
          {selectedMethod.publicConfig.bankName&&<div><b>البنك:</b> {selectedMethod.publicConfig.bankName}</div>}
          {selectedMethod.publicConfig.accountName&&<div><b>اسم الحساب:</b> {selectedMethod.publicConfig.accountName}</div>}
          {selectedMethod.publicConfig.iban&&<div><b>IBAN:</b> <span dir="ltr">{selectedMethod.publicConfig.iban}</span></div>}
        </div>}
        {selectedMethod?.key==='paymob'&&<PaymobBillingFields
          firstName={billingFirstName} lastName={billingLastName}
          email={billingEmail} phone={billingPhone}
          onFirstName={setBillingFirstName} onLastName={setBillingLastName}
          onEmail={setBillingEmail} onPhone={setBillingPhone}
        />}
        <label><span>ملاحظات الطلب <small>(اختياري)</small></span><textarea rows="3" maxLength="1000" value={notes} onChange={event=>setNotes(event.target.value)}/></label>
        <dl><div><dt>سعر الإضافة السنوي</dt><dd>{money(subtotal,checkout.item.currency)}</dd></div><div><dt>ضريبة القيمة المضافة 15%</dt><dd>{money(tax,checkout.item.currency)}</dd></div><div><dt>الإجمالي</dt><dd>{money(subtotal+tax,checkout.item.currency)}</dd></div></dl>
        <footer><button type="button" onClick={()=>setCheckout(null)}>رجوع</button><button type="submit" className={styles.primary} disabled={busy==='checkout'||!paymentMethods.length}>{busy==='checkout'?'جارٍ إنشاء الطلب…':selectedMethod?.key==='paymob'?'المتابعة إلى الدفع الآمن':'إنشاء طلب الاشتراك'}</button></footer>
      </form>
    </div>}

    {transferOrder&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} aria-label="إغلاق" onClick={()=>setTransferOrder(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" onSubmit={submitTransfer}>
        <header><div><small>إثبات التحويل البنكي</small><h2>{transferOrder.orderNumber||'طلب الإضافة'}</h2></div><button type="button" onClick={()=>setTransferOrder(null)} aria-label="إغلاق">×</button></header>
        <p>{bankConfig.instructionsAr||'أدخل بيانات التحويل ليتم مراجعتها من إدارة المنصة.'}</p>
        {bankConfig.bankName&&<div className={styles.info}><b>{bankConfig.bankName}</b>{bankConfig.accountName&&<div>{bankConfig.accountName}</div>}{bankConfig.iban&&<div dir="ltr">{bankConfig.iban}</div>}</div>}
        <label><span>اسم المحوّل</span><input value={senderName} onChange={event=>setSenderName(event.target.value)} minLength="2" maxLength="160" required/></label>
        <label><span>مرجع / رقم عملية التحويل</span><input dir="ltr" value={transferReference} onChange={event=>setTransferReference(event.target.value)} minLength="3" maxLength="160" required/></label>
        <label><span>تاريخ التحويل</span><input type="date" value={transferDate} onChange={event=>setTransferDate(event.target.value)} required/></label>
        <div className={styles.activationNote}><span>!</span><p>إرسال بيانات التحويل لا يعني قبول الدفع. تظل الإضافة غير مفعلة حتى تعتمد الإدارة التحويل.</p></div>
        <footer><button type="button" onClick={()=>setTransferOrder(null)}>رجوع</button><button type="submit" className={styles.primary} disabled={busy==='transfer'}>{busy==='transfer'?'جارٍ الإرسال…':'إرسال للمراجعة'}</button></footer>
      </form>
    </div>}

    {paymobOrder&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} type="button" aria-label="إغلاق" onClick={()=>setPaymobOrder(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="addon-paymob-title" onSubmit={continuePaymob}>
        <header><div><small>دفع إلكتروني آمن</small><h2 id="addon-paymob-title">{paymobOrder.order.orderNumber||'طلب الإضافة'}</h2></div><button type="button" onClick={()=>setPaymobOrder(null)} aria-label="إغلاق">×</button></header>
        <p>أدخل بيانات الفاتورة، ثم سننقلك إلى صفحة Paymob المشفّرة لإكمال الدفع. لا تُفعّل الإضافة إلا بعد وصول تأكيد الدفع الموثق إلى أودير.</p>
        <PaymobBillingFields
          firstName={billingFirstName} lastName={billingLastName}
          email={billingEmail} phone={billingPhone}
          onFirstName={setBillingFirstName} onLastName={setBillingLastName}
          onEmail={setBillingEmail} onPhone={setBillingPhone}
        />
        <footer><button type="button" onClick={()=>setPaymobOrder(null)}>رجوع</button><button type="submit" className={styles.primary} disabled={Boolean(busy)}>{busy==='paymob-'+paymobOrder.order.id?'جارٍ فتح الدفع…':'المتابعة إلى Paymob'}</button></footer>
      </form>
    </div>}
  </section>;
}

function PaymobBillingFields({
  firstName,lastName,email,phone,
  onFirstName,onLastName,onEmail,onPhone
}){
  return <fieldset className={styles.paymobFields}>
    <legend>بيانات الفاتورة والدفع</legend>
    <label><span>الاسم الأول</span><input autoComplete="given-name" value={firstName} onChange={event=>onFirstName(event.target.value)} minLength="2" maxLength="100" required/></label>
    <label><span>اسم العائلة</span><input autoComplete="family-name" value={lastName} onChange={event=>onLastName(event.target.value)} minLength="2" maxLength="100" required/></label>
    <label><span>البريد الإلكتروني</span><input type="email" inputMode="email" autoComplete="email" dir="ltr" value={email} onChange={event=>onEmail(event.target.value)} maxLength="254" required/></label>
    <label><span>رقم الجوال السعودي</span><input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={phone} onChange={event=>onPhone(event.target.value)} pattern="(?:[+]9665[0-9]{8}|05[0-9]{8})" title="اكتب الرقم بصيغة 05XXXXXXXX أو +9665XXXXXXXX" placeholder="+9665XXXXXXXX" required/></label>
    <label className={styles.paymentConsent}><input type="checkbox" required/><span>أوافق على إرسال بيانات الفاتورة أعلاه إلى Paymob لإتمام الدفع.</span></label>
    <p>لن يطلب أودير رقم البطاقة أو رمزها السري؛ تُدخل بيانات البطاقة داخل صفحة Paymob فقط.</p>
  </fieldset>;
}

function AddonCard({slug,item,canPurchase,pending,busy,onActivateFree,onBuy}){
  const enabled=Boolean(item.entitlement?.enabled);
  const free=item.pricingMode==='free'||Number(item.amountMinor||0)===0;
  const target=ADDON_LINKS[item.key]||'settings?tab=addons';
  return <article className={[styles.card,styles.addon,enabled?styles.installed:''].join(' ')}>
    <header><span>{item.categoryName||ADDON_CATEGORIES[item.categoryKey]||'إضافة أودير'}</span>{item.badge&&<b>{item.badge}</b>}</header>
    <div className={styles.addonTitle}><i aria-hidden="true">+</i><h2>{item.name}</h2></div>
    <p>{item.description}</p>
    <div className={styles.details}>
      <span><small>النوع</small><b>{free?'مجانية':'مدفوعة'}</b></span>
      <span><small>التفعيل</small><b>{free?'فوري':'بعد اعتماد الدفع'}</b></span>
    </div>
    <footer>
      <div><small>{free?'السعر':'الاشتراك السنوي'}</small><strong>{free?'مجاني':money(item.amountMinor,item.currency)}</strong>{!free&&<em>+ الضريبة</em>}</div>
      {enabled?<Link href={'/tenant/'+encodeURIComponent(slug)+'/'+target}>فتح الإضافة</Link>
        :free?<button type="button" disabled={!canPurchase||Boolean(busy)} onClick={onActivateFree}>{busy==='free-'+item.key?'جارٍ التفعيل…':'تفعيل مجانًا'}</button>
        :<button type="button" disabled={!canPurchase||pending||Boolean(busy)} onClick={onBuy}>{pending?'بانتظار الدفع':'اشترك سنويًا'}</button>}
    </footer>
  </article>;
}
