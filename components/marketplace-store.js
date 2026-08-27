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
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const services=data.services||EMPTY;
  const orders=useMemo(()=>
    (data.orders||EMPTY).filter(isServiceOrder),
  [data.orders]);
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
    if(item.pricingMode==='quote')return;
    const selected=preferredPackage(item);
    setCheckout({item,requestKey:idempotencyKey()});
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
    setNotice('');
    setError('');
  }

  async function createOrder(event){
    event.preventDefault();
    if(!checkout||busy||checkout.item.pricingMode==='quote')return;
    setBusy('checkout');
    setError('');
    setNotice('');
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
      const order=result.data||{};
      setCheckout(null);
      setNotice(
        (order.duplicate?'تم استرجاع طلب الخدمة القائم ':'تم إنشاء طلب الخدمة ')
        +(order.orderNumber||'')
        +'. بعد تأكيد الدفع يبدأ مسار الإسناد والتنفيذ ويمكنك متابعة الحالة من هنا.'
      );
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إنشاء طلب الخدمة');
    }finally{
      setBusy('');
    }
  }

  async function cancelOrder(orderId){
    if(busy)return;
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
        {orders.map(order=><article key={order.id}>
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
          <div><small>{order.dueAt?'موعد التسليم':'التاريخ'}</small><b>{date(order.dueAt||order.createdAt)}</b></div>
          {order.status==='pending_payment'&&<button
            type="button"
            className={styles.cancel}
            disabled={Boolean(busy)}
            onClick={()=>cancelOrder(order.id)}
          >{busy==='cancel-'+order.id?'جارٍ الإلغاء…':'إلغاء'}</button>}
        </article>)}
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
          {checkout.item.pricingMode!=='quote'&&<label className={!packageId?styles.packageOptionSelected:styles.packageOption}>
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
            {busy==='checkout'?'جارٍ إنشاء الطلب…':'تأكيد طلب الخدمة'}
          </button>
        </footer>
      </form>
    </div>}
  </section>;
}

function ServiceCard({item,canPurchase,pending,onBuy}){
  const provider=item.provider;
  const course=item.course;
  const packages=item.packages||EMPTY;
  const featuredPackage=preferredPackage(item);
  const isQuote=item.pricingMode==='quote';
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
      <button type="button" disabled={!canPurchase||pending||isQuote} onClick={onBuy}>
        {pending?'طلب دفع قائم':isQuote?'طلب عرض السعر قريبًا':'اختيار وطلب الخدمة'}
      </button>
    </footer>
    {isQuote&&<p className={styles.quoteHint}>هذه الخدمة تحتاج عرض سعر مخصص. سيتم تفعيل مسار طلب العروض في المرحلة التالية، ولن يُنشأ منها طلب دفع حاليًا.</p>}
  </article>;
}

function Empty(){
  return <div className={styles.empty}><span>⌕</span><h2>لا توجد نتائج مطابقة</h2><p>جرّب قسمًا آخر أو غيّر عبارة البحث.</p></div>;
}
