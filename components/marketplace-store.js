'use client';
/* eslint-disable @next/next/no-img-element */

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
const ASSIGNMENT_STATUS={
  pending:'بانتظار الإسناد',
  assigned:'تم الإسناد',
  accepted:'قبله مقدم الخدمة',
  in_progress:'قيد التنفيذ',
  delivered:'تم التسليم',
  completed:'مكتمل',
  cancelled:'ملغي'
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
const DELIVERY_MODES=[
  {value:'',label:'يُحدد لاحقًا'},
  {value:'online',label:'عن بُعد'},
  {value:'onsite',label:'حضوري'},
  {value:'hybrid',label:'مدمج'}
];

function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency,
    maximumFractionDigits:2
  }).format((Number(amountMinor)||0)/100);
}
function date(value){
  if(!value)return '—';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',
    timeStyle:'short'
  }).format(new Date(value));
}
function idempotencyKey(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  return 'service-'+Date.now()+'-'+Math.random().toString(36).slice(2);
}
function itemProductKey(order){
  return order?.items?.[0]?.productKey||'';
}
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
function isServiceOrder(order){
  const kind=order?.kind||order?.orderKind;
  if(kind)return kind==='service';
  const itemType=order?.items?.[0]?.itemType;
  return !itemType||itemType==='service';
}
function providerInitials(provider){
  const words=String(provider?.name||'مقدم خدمة').trim().split(/\s+/).slice(0,2);
  return words.map(word=>word[0]).join('')||'خ';
}
function preferredPackage(item){
  const packages=item?.packages||EMPTY;
  return packages.find(pkg=>pkg.recommended)||packages[0]||null;
}

export default function MarketplaceStore({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const paymentMethods=data.paymentMethods||EMPTY;
  const [query,setQuery]=useState('');
  const [category,setCategory]=useState('all');
  const [checkout,setCheckout]=useState(null);
  const [packageId,setPackageId]=useState('');
  const [quantity,setQuantity]=useState(1);
  const [preferredStartDate,setPreferredStartDate]=useState('');
  const [deliveryMode,setDeliveryMode]=useState('');
  const [goal,setGoal]=useState('');
  const [audience,setAudience]=useState('');
  const [participantCount,setParticipantCount]=useState('');
  const [requirements,setRequirements]=useState('');
  const [notes,setNotes]=useState('');
  const [paymentProvider,setPaymentProvider]=useState(
    paymentMethods[0]?.key||'bank_transfer'
  );
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
  const services=data.services||EMPTY;
  const orders=useMemo(()=>
    (data.orders||EMPTY).filter(isServiceOrder),
  [data.orders]);
  const transfers=data.bankTransferSubmissions||EMPTY;
  const transferByOrder=useMemo(
    ()=>new Map(transfers.map(item=>[item.orderId,item])),
    [transfers]
  );
  const canPurchase=Boolean(data.viewer?.canPurchase);

  const filteredServices=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return services.filter(item=>{
      const provider=item.provider||{};
      const course=item.course||{};
      const searchValues=[
        item.name,item.description,item.shortDescription,item.categoryName,
        provider.name,provider.title,provider.shortBio,
        ...(provider.expertise||EMPTY),
        course.title,course.summary,course.targetAudience
      ];
      return (category==='all'||item.categoryKey===category)
        &&(!needle||searchValues.some(value=>
          String(value||'').toLocaleLowerCase('ar').includes(needle)
        ));
    });
  },[services,category,query]);

  function openCheckout(item){
    if(item.pricingMode==='quote'
       ||(item.pricingMode==='from'&&!(item.packages||EMPTY).length))return;
    const selected=preferredPackage(item);
    setCheckout({
      item,
      requestKey:idempotencyKey(),
      paymentRequestKey:idempotencyKey()
    });
    setPackageId(selected?.id||'');
    setQuantity(1);
    setPreferredStartDate('');
    setDeliveryMode('');
    setGoal('');
    setAudience('');
    setParticipantCount('');
    setRequirements('');
    setNotes('');
    setPaymentProvider(paymentMethods[0]?.key||'bank_transfer');
    resetBillingContact();
    setNotice('');
    setError('');
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
    if(!checkout||busy||checkout.item.pricingMode==='quote'
       ||(checkout.item.pricingMode==='from'&&!packageId))return;
    setBusy('checkout');
    setError('');
    setNotice('');
    let order=null;
    let navigating=false;
    try{
      const response=await fetch('/api/tenant/service-marketplace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:'create_service_order',
          p_payload:{
            productKey:checkout.item.key,
            packageId:packageId||undefined,
            quantity:Number(quantity),
            preferredStartDate:preferredStartDate||undefined,
            deliveryMode:deliveryMode||undefined,
            brief:{
              goal:goal.trim()||undefined,
              audience:audience.trim()||undefined,
              participantCount:participantCount?Number(participantCount):undefined,
              requirements:requirements.trim()||undefined
            },
            notes:notes.trim()||undefined,
            paymentProvider,
            idempotencyKey:checkout.requestKey
          }
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر إنشاء طلب الخدمة');
      order=result.data||{};
      setCheckout(null);
      if(order.paymentProvider==='bank_transfer'){
        setTransferOrder(order);
        setSenderName('');setTransferReference('');setTransferDate(today());
        setNotice('تم إنشاء طلب الخدمة '+(order.orderNumber||'')+'. أدخل بيانات التحويل لإرساله إلى المراجعة.');
        router.refresh();
      }else if(order.paymentProvider==='paymob'){
        navigating=await redirectToPaymob(order,checkout.paymentRequestKey);
      }else{
        setNotice(
          (order.duplicate?'تم استرجاع طلب الخدمة القائم ':'تم إنشاء طلب الخدمة ')
          +(order.orderNumber||'')
          +'. بعد تأكيد الدفع يبدأ مسار الإسناد والتنفيذ ويمكنك متابعة الحالة من هنا.'
        );
        router.refresh();
      }
    }catch(err){
      if(order?.id){
        setCheckout(null);
        setError('تم حفظ طلب الخدمة، لكن '+(err instanceof Error?err.message:'تعذر فتح صفحة الدفع')+'. يمكنك استكمال الدفع من سجل طلبات الخدمات.');
        router.refresh();
      }else{
        setError(err instanceof Error?err.message:'تعذر إنشاء طلب الخدمة');
      }
    }finally{
      if(!navigating)setBusy('');
    }
  }

  function openTransfer(order){
    setTransferOrder(order);setSenderName('');setTransferReference('');
    setTransferDate(today());setError('');setNotice('');
  }

  async function submitTransfer(event){
    event.preventDefault();
    if(!transferOrder||busy)return;
    setBusy('transfer');setError('');setNotice('');
    try{
      const response=await fetch('/api/tenant/service-marketplace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:'submit_bank_transfer',
          p_payload:{
            orderId:transferOrder.id,
            senderName,
            transferReference,
            transferDate
          }
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر إرسال بيانات التحويل');
      setTransferOrder(null);
      setNotice('تم إرسال بيانات التحويل للمراجعة. لن يبدأ تنفيذ الخدمة قبل اعتماد الدفع من إدارة المنصة.');
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إرسال بيانات التحويل');
    }finally{
      setBusy('');
    }
  }

  function openPaymob(order){
    setPaymobOrder({order,paymentRequestKey:idempotencyKey()});
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
    }finally{
      if(!navigating)setBusy('');
    }
  }

  async function cancelOrder(order){
    if(busy)return;
    if(order?.paymentProvider==='paymob'){
      setError('لا يمكن إلغاء طلب Paymob قبل حسم حالة العملية. استكمل نفس الدفع أو تابع المطابقة، وتواصل مع الدعم برقم الطلب إذا استمر التعليق.');
      return;
    }
    const orderId=order?.id;
    if(!orderId)return;
    setBusy('cancel-'+orderId);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/service-marketplace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:'cancel_order',
          p_payload:{orderId}
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر إلغاء الطلب');
      setNotice('تم إلغاء طلب الخدمة المعلق.');
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إلغاء الطلب');
    }finally{
      setBusy('');
    }
  }

  const categories=[{key:'all',name:'كل الخدمات'},...(data.categories||EMPTY)];
  const selectedPackage=checkout
    ?(checkout.item.packages||EMPTY).find(item=>item.id===packageId)||null
    :null;
  const checkoutUnitAmount=checkout
    ?Number(selectedPackage?.amountMinor??checkout.item.amountMinor??0)
    :0;
  const checkoutCurrency=selectedPackage?.currency||checkout?.item.currency||'SAR';
  const checkoutSubtotal=checkoutUnitAmount*(Number(quantity)||1);
  const checkoutTax=Math.round(checkoutSubtotal*.15);
  const selectedMethod=paymentMethods.find(item=>item.key===paymentProvider);
  const bankConfig=paymentMethods.find(item=>item.key==='bank_transfer')?.publicConfig||{};
  const openOrders=orders.filter(order=>['pending_payment','paid','in_progress'].includes(order.status)).length;

  return <section className={styles.store}>
    <header className={styles.hero}>
      <div>
        <span>خدمات احترافية موثوقة</span>
        <h1>متجر الخدمات المتخصصة</h1>
        <p>اختر المحاضر أو الخبير المناسب، راجع خبرته والدورة والباقات، ثم أرسل متطلبات منشأتك في طلب واحد واضح وقابل للتتبع.</p>
      </div>
      <aside>
        <b>الخدمات والإضافات منفصلتان</b>
        <small>هذه الصفحة للخدمات البشرية والتنفيذية فقط. وفي متجر الإضافات المستقل تُثبت الإضافة آليًا في هذه المنشأة فقط.</small>
        <Link className={styles.addonsLink} href={'/tenant/'+encodeURIComponent(slug)+'/addons-store'}>الانتقال إلى متجر الإضافات</Link>
      </aside>
    </header>

    <section className={styles.kpis}>
      <article><span>خدمات متاحة</span><b>{data.summary?.serviceProducts??services.length}</b><small>ضمن {data.categories?.length||0} أقسام</small></article>
      <article><span>مقدمو خدمات</span><b>{data.summary?.serviceProviders??data.providers?.length??0}</b><small>خبراء ومحاضرون وشركات</small></article>
      <article><span>طلبات مفتوحة</span><b>{openOrders}</b><small>بانتظار الدفع أو التنفيذ</small></article>
      <article><span>طلبات مكتملة</span><b>{orders.filter(order=>order.status==='completed').length}</b><small>محفوظة في سجل منشأتك</small></article>
    </section>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {!canPurchase&&<div className={styles.info}>يمكنك استعراض الخدمات ومقدميها، والطلب متاح لمالك المنشأة أو من لديه صلاحية إدارة الاشتراك.</div>}

    <section className={styles.filters}>
      <label>
        <span aria-hidden="true">⌕</span>
        <input aria-label="البحث في الخدمات" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث باسم الخدمة أو المحاضر أو التخصص…"/>
      </label>
      <div>
        {categories.map(item=><button
          type="button"
          key={item.key}
          className={category===item.key?styles.selected:''}
          onClick={()=>setCategory(item.key)}
        >{item.name}</button>)}
      </div>
    </section>

    <section className={styles.grid}>
      {filteredServices.map(item=><ServiceCard
        key={item.id}
        item={item}
        canPurchase={canPurchase}
        pending={orders.some(order=>order.status==='pending_payment'&&itemProductKey(order)===item.key)}
        onBuy={()=>openCheckout(item)}
      />)}
      {!filteredServices.length&&<Empty/>}
    </section>

    <section className={styles.orders}>
      <header><div><small>سجل منشأتك</small><h2>طلبات الخدمات الأخيرة</h2></div><span>{orders.length} طلب</span></header>
      <div className={styles.orderList}>
        {orders.map(order=>{
          const transfer=transferByOrder.get(order.id);
          return <article key={order.id}>
          <div className={styles.orderIdentity}>
            <b>{order.orderNumber}</b>
            <small>{order.items?.map(item=>item.name).join('، ')||'طلب خدمة'}</small>
            {(order.providerName||order.assignmentStatus)&&<span className={styles.orderMeta}>
              {order.providerName&&<>مقدم الخدمة: {order.providerName}</>}
              {order.providerName&&order.assignmentStatus&&' • '}
              {order.assignmentStatus&&(ASSIGNMENT_STATUS[order.assignmentStatus]||order.assignmentStatus)}
            </span>}
          </div>
          <span className={[styles.status,styles[order.status]||''].join(' ')}>{STATUS[order.status]||order.status}</span>
          <div><small>الإجمالي</small><b>{money(order.totalMinor,order.currency)}</b></div>
          <div><small>طريقة الدفع</small><b>{paymentProviderName(order.paymentProvider,paymentMethods)}</b>{transfer&&<small>{TRANSFER_STATUS[transfer.status]||transfer.status}</small>}{order.status==='pending_payment'&&order.paymentProvider==='paymob'&&<small className={styles.paymobOrderGuard}>استكمل نفس العملية أو تابع المطابقة؛ لا تبدأ دفعة أخرى. تواصل مع الدعم برقم الطلب إذا استمر التعليق.</small>}<small>{date(order.dueAt||order.createdAt)}</small></div>
          {order.status==='pending_payment'&&order.paymentProvider==='bank_transfer'&&(!transfer||transfer.status==='rejected')&&<button
            type="button"
            className={styles.payButton}
            disabled={Boolean(busy)}
            onClick={()=>openTransfer(order)}
          >إرسال بيانات التحويل</button>}
          {order.status==='pending_payment'&&order.paymentProvider==='paymob'&&<button
            type="button"
            className={styles.payButton}
            disabled={Boolean(busy)}
            onClick={()=>openPaymob(order)}
          >{busy==='paymob-'+order.id?'جارٍ فتح الدفع…':'استكمال الدفع'}</button>}
          {order.status==='pending_payment'&&order.paymentProvider!=='paymob'&&<button
            type="button"
            className={styles.cancel}
            disabled={Boolean(busy)}
            onClick={()=>cancelOrder(order)}
          >{busy==='cancel-'+order.id?'جارٍ الإلغاء…':'إلغاء'}</button>}
        </article>})}
        {!orders.length&&<div className={styles.emptyOrders}>لم تُنشئ منشأتك طلبات خدمات حتى الآن.</div>}
      </div>
    </section>

    {checkout&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} type="button" aria-label="إغلاق" onClick={()=>setCheckout(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="service-checkout-title" onSubmit={createOrder}>
        <header>
          <div><small>طلب خدمة</small><h2 id="service-checkout-title">{checkout.item.name}</h2></div>
          <button type="button" onClick={()=>setCheckout(null)} aria-label="إغلاق">×</button>
        </header>
        <p>{checkout.item.description}</p>

        {(checkout.item.packages||EMPTY).length>0&&<fieldset className={styles.packageOptions}>
          <legend>اختر الباقة المناسبة</legend>
          {(checkout.item.packages||EMPTY).map(pkg=><label
            key={pkg.id}
            className={packageId===pkg.id?styles.packageOptionSelected:styles.packageOption}
          >
            <input type="radio" name="servicePackage" value={pkg.id} checked={packageId===pkg.id} onChange={()=>setPackageId(pkg.id)}/>
            <span><b>{pkg.name}</b>{pkg.recommended&&<em>موصى بها</em>}<small>{pkg.description}</small></span>
            <strong>{money(pkg.amountMinor,pkg.currency)}</strong>
          </label>)}
          {checkout.item.pricingMode==='fixed'&&<label className={!packageId?styles.packageOptionSelected:styles.packageOption}>
            <input type="radio" name="servicePackage" value="" checked={!packageId} onChange={()=>setPackageId('')}/>
            <span><b>الخدمة الأساسية</b><small>{checkout.item.unitLabel||'حسب وصف الخدمة'}</small></span>
            <strong>{money(checkout.item.amountMinor,checkout.item.currency)}</strong>
          </label>}
        </fieldset>}

        <div className={styles.briefGrid}>
          <label>
            <span>الكمية</span>
            <input type="number" min="1" max="100" required value={quantity} onChange={event=>setQuantity(event.target.value)}/>
          </label>
          <label>
            <span>تاريخ البدء المفضل <small>(اختياري)</small></span>
            <input type="date" value={preferredStartDate} onChange={event=>setPreferredStartDate(event.target.value)}/>
          </label>
          <label>
            <span>طريقة التنفيذ</span>
            <select value={deliveryMode} onChange={event=>setDeliveryMode(event.target.value)}>
              {DELIVERY_MODES.map(mode=><option key={mode.value} value={mode.value}>{mode.label}</option>)}
            </select>
          </label>
          <label>
            <span>وسيلة الدفع</span>
            <select
              value={paymentProvider}
              onChange={event=>setPaymentProvider(event.target.value)}
              required
            >
              {paymentMethods.map(method=><option key={method.key} value={method.key}>{method.name}</option>)}
            </select>
          </label>
          <label>
            <span>عدد المستفيدين <small>(اختياري)</small></span>
            <input type="number" min="1" max="100000" value={participantCount} onChange={event=>setParticipantCount(event.target.value)}/>
          </label>
          <label className={styles.full}>
            <span>الهدف من الخدمة <small>(اختياري)</small></span>
            <textarea rows="2" maxLength="1000" value={goal} onChange={event=>setGoal(event.target.value)} placeholder="ما النتيجة التي تريد منشأتك الوصول إليها؟"/>
          </label>
          <label className={styles.full}>
            <span>الفئة المستهدفة <small>(اختياري)</small></span>
            <input maxLength="500" value={audience} onChange={event=>setAudience(event.target.value)} placeholder="مثال: مديرو المراكز أو المتدربون الجدد"/>
          </label>
          <label className={styles.full}>
            <span>المتطلبات والتفاصيل <small>(اختياري)</small></span>
            <textarea rows="3" maxLength="3000" value={requirements} onChange={event=>setRequirements(event.target.value)} placeholder="الموضوع، المخرجات، المواعيد أو أي اشتراطات مهمة…"/>
          </label>
          <label className={styles.full}>
            <span>ملاحظات إدارية <small>(اختياري)</small></span>
            <textarea rows="2" maxLength="1000" value={notes} onChange={event=>setNotes(event.target.value)} placeholder="أي ملاحظة لفريق متابعة الطلب…"/>
          </label>
        </div>

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

        <dl>
          <div><dt>السعر</dt><dd>{money(checkoutSubtotal,checkoutCurrency)}</dd></div>
          <div><dt>ضريبة القيمة المضافة 15%</dt><dd>{money(checkoutTax,checkoutCurrency)}</dd></div>
          <div><dt>الإجمالي</dt><dd>{money(checkoutSubtotal+checkoutTax,checkoutCurrency)}</dd></div>
        </dl>
        <div className={styles.activationNote}>
          <span>✓</span>
          <p>يُحفظ السعر والباقة ومتطلبات الطلب داخل سجل منشأتك. بعد تأكيد الدفع يبدأ الإسناد لمقدم الخدمة ويمكن متابعة الحالة من هذه الصفحة.</p>
        </div>
        <footer>
          <button type="button" onClick={()=>setCheckout(null)}>رجوع</button>
          <button type="submit" className={styles.primary} disabled={busy==='checkout'||!paymentMethods.length}>
            {busy==='checkout'?'جارٍ إنشاء الطلب…':selectedMethod?.key==='paymob'?'المتابعة إلى الدفع الآمن':'تأكيد طلب الخدمة'}
          </button>
        </footer>
      </form>
    </div>}

    {transferOrder&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} type="button" aria-label="إغلاق" onClick={()=>setTransferOrder(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="service-transfer-title" onSubmit={submitTransfer}>
        <header><div><small>إثبات التحويل البنكي للخدمة</small><h2 id="service-transfer-title">{transferOrder.orderNumber||'طلب الخدمة'}</h2></div><button type="button" onClick={()=>setTransferOrder(null)} aria-label="إغلاق">×</button></header>
        <p>{bankConfig.instructionsAr||'حوّل المبلغ إلى الحساب الموضح، ثم أدخل بيانات العملية ليتم فحصها واعتمادها.'}</p>
        {(bankConfig.bankName||bankConfig.iban)&&<div className={styles.info}>
          {bankConfig.bankName&&<div><b>البنك:</b> {bankConfig.bankName}</div>}
          {bankConfig.accountName&&<div><b>اسم الحساب:</b> {bankConfig.accountName}</div>}
          {bankConfig.iban&&<div><b>IBAN:</b> <span dir="ltr">{bankConfig.iban}</span></div>}
        </div>}
        <label><span>اسم المحوّل</span><input value={senderName} onChange={event=>setSenderName(event.target.value)} minLength="2" maxLength="160" required/></label>
        <label><span>مرجع / رقم عملية التحويل</span><input dir="ltr" value={transferReference} onChange={event=>setTransferReference(event.target.value)} minLength="3" maxLength="160" required/></label>
        <label><span>تاريخ التحويل</span><input type="date" value={transferDate} onChange={event=>setTransferDate(event.target.value)} required/></label>
        <div className={styles.activationNote}><span>!</span><p>إرسال البيانات لا يعني قبول الدفع. لن يبدأ إسناد الخدمة أو تنفيذها حتى تعتمد إدارة المنصة التحويل.</p></div>
        <footer><button type="button" onClick={()=>setTransferOrder(null)}>رجوع</button><button type="submit" className={styles.primary} disabled={busy==='transfer'}>{busy==='transfer'?'جارٍ الإرسال…':'إرسال للمراجعة'}</button></footer>
      </form>
    </div>}

    {paymobOrder&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} type="button" aria-label="إغلاق" onClick={()=>setPaymobOrder(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="service-paymob-title" onSubmit={continuePaymob}>
        <header><div><small>دفع خدمة عبر Paymob</small><h2 id="service-paymob-title">{paymobOrder.order.orderNumber||'طلب الخدمة'}</h2></div><button type="button" onClick={()=>setPaymobOrder(null)} aria-label="إغلاق">×</button></header>
        <p>أدخل بيانات الفاتورة، ثم سننقلك إلى صفحة Paymob المشفّرة. لا يبدأ تنفيذ الخدمة إلا بعد وصول تأكيد الدفع الموثق إلى أودير.</p>
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

function ServiceCard({item,canPurchase,pending,onBuy}){
  const provider=item.provider;
  const course=item.course;
  const packages=item.packages||EMPTY;
  const featuredPackage=preferredPackage(item);
  const isQuote=item.pricingMode==='quote';
  const needsQuote=isQuote||(item.pricingMode==='from'&&!featuredPackage);
  const displayedAmount=featuredPackage?.amountMinor??item.amountMinor;
  const displayedCurrency=featuredPackage?.currency||item.currency;
  return <article className={styles.card}>
    <header><span>{item.categoryName}</span>{item.badge&&<b>{item.badge}</b>}</header>
    {item.imageUrl&&<img className={styles.serviceImage} src={item.imageUrl} alt="" loading="lazy"/>}
    <h2>{item.name}</h2>
    <p>{item.shortDescription||item.description}</p>

    {provider&&<section className={styles.providerStrip} aria-label="مقدم الخدمة">
      <div className={styles.avatar}>
        {provider.avatarUrl?<img src={provider.avatarUrl} alt={'صورة '+provider.name} loading="lazy"/>:<span>{providerInitials(provider)}</span>}
      </div>
      <div className={styles.providerIdentity}>
        <div><b>{provider.name}</b>{provider.verified&&<span className={styles.verified} title="موثق">✓ موثق</span>}</div>
        <small>{provider.title||provider.shortBio||'مقدم خدمة متخصص'}</small>
        <p>
          {provider.yearsExperience?provider.yearsExperience+' سنوات خبرة':''}
          {provider.yearsExperience&&provider.rating>0?' • ':''}
          {provider.rating>0?'★ '+provider.rating+' ('+(provider.reviewCount||0)+')':''}
        </p>
      </div>
    </section>}

    {provider?.expertise?.length>0&&<div className={styles.expertise} aria-label="التخصصات">
      {provider.expertise.slice(0,4).map(skill=><span key={skill}>{skill}</span>)}
    </div>}

    {course&&<section className={styles.courseBox}>
      <div><small>الدورة أو البرنامج</small><b>{course.title}</b></div>
      {course.summary&&<p>{course.summary}</p>}
      <div className={styles.courseMeta}>
        {course.durationHours&&<span>{course.durationHours} ساعة</span>}
        {course.language&&<span>{course.language}</span>}
        {course.accreditation&&<span>{course.accreditation}</span>}
      </div>
    </section>}

    {packages.length>0&&<div className={styles.packagesPreview}>
      <small>الباقات المتاحة</small>
      <div>{packages.slice(0,3).map(pkg=><span key={pkg.id} className={pkg.recommended?styles.recommendedPackage:''}>{pkg.name}{pkg.recommended?' • موصى بها':''}</span>)}</div>
    </div>}

    <div className={styles.details}>
      <span><small>التسليم المتوقع</small><b>{featuredPackage?.turnaroundDays||item.turnaroundDays?(featuredPackage?.turnaroundDays||item.turnaroundDays)+' أيام':'حسب الاتفاق'}</b></span>
      <span><small>وحدة الخدمة</small><b>{item.unitLabel||'حسب الاتفاق'}</b></span>
    </div>
    <footer>
      <div>
        <small>{isQuote?'التسعير':featuredPackage?'الباقة المقترحة':item.pricingMode==='from'?'يبدأ من':'السعر'}</small>
        <strong>{isQuote?'حسب المتطلبات':money(displayedAmount,displayedCurrency)}</strong>
        {!isQuote&&<em>+ الضريبة</em>}
      </div>
      <button type="button" disabled={!canPurchase||pending||needsQuote} onClick={onBuy}>
        {pending?'طلب دفع قائم':needsQuote?'طلب عرض سعر':item.pricingMode==='from'?'اختيار باقة وطلب الخدمة':'اختيار وطلب الخدمة'}
      </button>
    </footer>
    {needsQuote&&<p className={styles.quoteHint}>هذه الخدمة تحتاج عرض سعر أو باقة ثابتة أولًا؛ لن يُنشأ طلب دفع إلكتروني قبل تثبيت السعر والمخرجات.</p>}
  </article>;
}

function Empty(){
  return <div className={styles.empty}><span>⌕</span><h2>لا توجد نتائج مطابقة</h2><p>جرّب قسمًا آخر أو غيّر عبارة البحث.</p></div>;
}
