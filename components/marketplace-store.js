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
const ADDON_CATEGORIES={
  all:'كل الإضافات',
  communications:'التواصل',
  commerce:'المتاجر',
  automation:'الأتمتة',
  marketing:'التسويق',
  telephony:'الاتصالات',
  website:'الموقع'
};
const ADDON_LINKS={
  yeastar:'yeastar',
  cms_pro:'website',
  marketing_attribution:'marketing',
  woocommerce:'integrations',
  salla:'integrations',
  zid:'integrations',
  shopify:'integrations',
  custom_store:'integrations'
};

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
  return 'marketplace-'+Date.now()+'-'+Math.random().toString(36).slice(2);
}
function itemProductKey(order){
  return order?.items?.[0]?.productKey||'';
}

export default function MarketplaceStore({slug,initialData,initialTab='services'}){
  const router=useRouter();
  const data=initialData||{};
  const [tab,setTab]=useState(initialTab==='addons'?'addons':'services');
  const [query,setQuery]=useState('');
  const [category,setCategory]=useState('all');
  const [checkout,setCheckout]=useState(null);
  const [quantity,setQuantity]=useState(1);
  const [notes,setNotes]=useState('');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const services=data.services||EMPTY;
  const addons=data.addons||EMPTY;
  const orders=data.orders||EMPTY;
  const canPurchase=Boolean(data.viewer?.canPurchase);

  const filteredServices=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return services.filter(item=>
      (category==='all'||item.categoryKey===category)
      &&(!needle||[item.name,item.description,item.categoryName].some(
        value=>String(value||'').toLocaleLowerCase('ar').includes(needle)
      ))
    );
  },[services,category,query]);

  const filteredAddons=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return addons.filter(item=>
      (category==='all'||item.categoryKey===category)
      &&(!needle||[item.name,item.description,item.badge].some(
        value=>String(value||'').toLocaleLowerCase('ar').includes(needle)
      ))
    );
  },[addons,category,query]);

  function selectTab(next){
    setTab(next);
    setCategory('all');
    setQuery('');
    setNotice('');
    setError('');
  }

  function openCheckout(item,itemType){
    setCheckout({item,itemType,requestKey:idempotencyKey()});
    setQuantity(1);
    setNotes('');
    setNotice('');
    setError('');
  }

  async function createOrder(event){
    event.preventDefault();
    if(!checkout||busy)return;
    setBusy('checkout');
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/marketplace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_slug:slug,
          p_action:'create_order',
          p_payload:{
            itemType:checkout.itemType,
            productKey:checkout.item.key,
            quantity:checkout.itemType==='addon'?1:Number(quantity),
            notes,
            idempotencyKey:checkout.requestKey
          }
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر إنشاء الطلب');
      const order=result.data||{};
      setCheckout(null);
      setNotice(
        (order.duplicate?'تم استرجاع طلب الشراء القائم ':'تم إنشاء طلب الشراء ')
        +(order.orderNumber||'')+'. عند تأكيد الدفع '
        +(checkout.itemType==='addon'
          ?'ستُثبت الإضافة تلقائيًا في منشأتك.'
          :'يبدأ فريق ماركتون تنفيذ الخدمة.')
      );
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إنشاء الطلب');
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
      const response=await fetch('/api/tenant/marketplace',{
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
      setNotice('تم إلغاء طلب الشراء المعلق.');
      router.refresh();
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إلغاء الطلب');
    }finally{
      setBusy('');
    }
  }

  const categories=tab==='services'
    ?[{key:'all',name:'كل الخدمات'},...(data.categories||EMPTY)]
    :Object.entries(ADDON_CATEGORIES).map(([key,name])=>({key,name}));
  const checkoutSubtotal=checkout
    ?Number(checkout.item.amountMinor||0)*(checkout.itemType==='addon'?1:Number(quantity)||1)
    :0;
  const checkoutTax=Math.round(checkoutSubtotal*.15);

  return <section className={styles.store}>
    <header className={styles.hero}>
      <div>
        <span>مُدار من ماركتون</span>
        <h1>{tab==='services'?'متجر الخدمات المتخصصة':'متجر الإضافات الذكية'}</h1>
        <p>{tab==='services'
          ?'اطلب المحاضرين والتصميم والمحتوى والتسويق والتشغيل من شركاء يفهمون قطاع التدريب.'
          :'اختر الإضافة التي تحتاجها منشأتك؛ وبعد تأكيد الدفع تُثبت تلقائيًا دون طلب دعم.'}</p>
      </div>
      <aside>
        <b>شراء آمن وقابل للتتبع</b>
        <small>كل طلب مرتبط بمنشأتك، وكل تفعيل إضافة موثق في سجل التدقيق.</small>
      </aside>
    </header>

    <section className={styles.kpis}>
      <article><span>خدمات متاحة</span><b>{data.summary?.serviceProducts||0}</b><small>ضمن {data.categories?.length||0} أقسام</small></article>
      <article><span>إضافات متاحة</span><b>{data.summary?.addonProducts||0}</b><small>تفعيل بعد الدفع</small></article>
      <article><span>إضافاتك النشطة</span><b>{data.summary?.activeAddons||0}</b><small>مرتبطة بهذه المنشأة</small></article>
      <article><span>طلبات مفتوحة</span><b>{data.summary?.openOrders||0}</b><small>دفع أو تنفيذ</small></article>
    </section>

    <div className={styles.switcher} role="tablist" aria-label="نوع المتجر">
      <button type="button" role="tab" aria-selected={tab==='services'} className={tab==='services'?styles.active:''} onClick={()=>selectTab('services')}>متجر الخدمات</button>
      <button type="button" role="tab" aria-selected={tab==='addons'} className={tab==='addons'?styles.active:''} onClick={()=>selectTab('addons')}>متجر الإضافات</button>
    </div>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {!canPurchase&&<div className={styles.info}>يمكنك استعراض المتجر، والشراء متاح لمالك المنشأة أو من لديه صلاحية إدارة الاشتراك.</div>}

    <section className={styles.filters}>
      <label>
        <span aria-hidden="true">⌕</span>
        <input aria-label="البحث في المتجر" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث في المتجر…"/>
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

    {tab==='services'?<section className={styles.grid}>
      {filteredServices.map(item=><ServiceCard
        key={item.id}
        item={item}
        canPurchase={canPurchase}
        pending={orders.some(order=>order.status==='pending_payment'&&itemProductKey(order)===item.key)}
        onBuy={()=>openCheckout(item,'service')}
      />)}
      {!filteredServices.length&&<Empty/>}
    </section>:<section className={styles.grid}>
      {filteredAddons.map(item=><AddonCard
        key={item.id}
        slug={slug}
        item={item}
        canPurchase={canPurchase}
        pending={orders.some(order=>order.status==='pending_payment'&&itemProductKey(order)===item.key)}
        onBuy={()=>openCheckout(item,'addon')}
      />)}
      {!filteredAddons.length&&<Empty/>}
    </section>}

    <section className={styles.orders}>
      <header><div><small>سجل منشأتك</small><h2>طلبات المتجر الأخيرة</h2></div><span>{orders.length} طلب</span></header>
      <div className={styles.orderList}>
        {orders.map(order=><article key={order.id}>
          <div className={styles.orderIdentity}>
            <b>{order.orderNumber}</b>
            <small>{order.items?.map(item=>item.name).join('، ')||'طلب متجر'}</small>
          </div>
          <span className={[styles.status,styles[order.status]||''].join(' ')}>{STATUS[order.status]||order.status}</span>
          <div><small>الإجمالي</small><b>{money(order.totalMinor,order.currency)}</b></div>
          <div><small>التاريخ</small><b>{date(order.createdAt)}</b></div>
          {order.status==='pending_payment'&&<button
            type="button"
            className={styles.cancel}
            disabled={Boolean(busy)}
            onClick={()=>cancelOrder(order.id)}
          >{busy==='cancel-'+order.id?'جارٍ الإلغاء…':'إلغاء'}</button>}
        </article>)}
        {!orders.length&&<div className={styles.emptyOrders}>لم تُنشئ منشأتك طلبات من المتجر حتى الآن.</div>}
      </div>
    </section>

    {checkout&&<div className={styles.modalLayer}>
      <button className={styles.backdrop} aria-label="إغلاق" onClick={()=>setCheckout(null)}/>
      <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="marketplace-checkout-title" onSubmit={createOrder}>
        <header>
          <div><small>{checkout.itemType==='addon'?'شراء إضافة':'طلب خدمة'}</small><h2 id="marketplace-checkout-title">{checkout.item.name}</h2></div>
          <button type="button" onClick={()=>setCheckout(null)} aria-label="إغلاق">×</button>
        </header>
        <p>{checkout.item.description}</p>
        {checkout.itemType==='service'&&<label>
          <span>الكمية</span>
          <input type="number" min="1" max="100" value={quantity} onChange={event=>setQuantity(event.target.value)}/>
        </label>}
        <label>
          <span>تفاصيل أو ملاحظات الطلب <small>(اختياري)</small></span>
          <textarea rows="4" maxLength="1000" value={notes} onChange={event=>setNotes(event.target.value)} placeholder="اكتب التخصص أو الموعد أو أي متطلبات مهمة…"/>
        </label>
        <dl>
          <div><dt>السعر</dt><dd>{money(checkoutSubtotal,checkout.item.currency)}</dd></div>
          <div><dt>ضريبة القيمة المضافة 15%</dt><dd>{money(checkoutTax,checkout.item.currency)}</dd></div>
          <div><dt>الإجمالي</dt><dd>{money(checkoutSubtotal+checkoutTax,checkout.item.currency)}</dd></div>
        </dl>
        <div className={styles.activationNote}>
          <span>✓</span>
          <p>{checkout.itemType==='addon'
            ?'بعد تأكيد الدفع تُثبت الإضافة آليًا في هذه المنشأة فقط، دون تغيير أي بيانات أو تكامل قائم.'
            :'بعد تأكيد الدفع يتحول الطلب مباشرة إلى فريق التنفيذ ويمكن متابعة حالته من هنا.'}</p>
        </div>
        <footer>
          <button type="button" onClick={()=>setCheckout(null)}>رجوع</button>
          <button type="submit" className={styles.primary} disabled={busy==='checkout'}>
            {busy==='checkout'?'جارٍ إنشاء الطلب…':'تأكيد طلب الشراء'}
          </button>
        </footer>
      </form>
    </div>}
  </section>;
}

function ServiceCard({item,canPurchase,pending,onBuy}){
  return <article className={styles.card}>
    <header><span>{item.categoryName}</span>{item.badge&&<b>{item.badge}</b>}</header>
    <h2>{item.name}</h2>
    <p>{item.description}</p>
    <div className={styles.details}>
      <span><small>التسليم المتوقع</small><b>{item.turnaroundDays?item.turnaroundDays+' أيام':'حسب الاتفاق'}</b></span>
      <span><small>وحدة الخدمة</small><b>{item.unitLabel}</b></span>
    </div>
    <footer>
      <div><small>{item.pricingMode==='from'?'يبدأ من':'السعر'}</small><strong>{money(item.amountMinor,item.currency)}</strong><em>+ الضريبة</em></div>
      <button type="button" disabled={!canPurchase||pending} onClick={onBuy}>{pending?'طلب دفع قائم':'اطلب الخدمة'}</button>
    </footer>
  </article>;
}

function AddonCard({slug,item,canPurchase,pending,onBuy}){
  const enabled=Boolean(item.entitlement?.enabled);
  const target=ADDON_LINKS[item.key]||'settings?tab=addons';
  return <article className={[styles.card,styles.addon,enabled?styles.installed:''].join(' ')}>
    <header><span>{ADDON_CATEGORIES[item.categoryKey]||'إضافة مُدار'}</span>{item.badge&&<b>{item.badge}</b>}</header>
    <div className={styles.addonTitle}><i aria-hidden="true">+</i><h2>{item.name}</h2></div>
    <p>{item.description}</p>
    <div className={styles.details}>
      <span><small>الفوترة</small><b>{item.interval==='year'?'سنوية':item.interval==='one_time'?'مرة واحدة':'شهرية'}</b></span>
      <span><small>التثبيت</small><b>تلقائي بعد الدفع</b></span>
    </div>
    <footer>
      <div><small>السعر</small><strong>{money(item.amountMinor,item.currency)}</strong><em>{item.interval==='month'?'/ شهريًا':''} + الضريبة</em></div>
      {enabled?<Link href={'/tenant/'+encodeURIComponent(slug)+'/'+target}>فتح الإضافة</Link>
        :<button type="button" disabled={!canPurchase||pending} onClick={onBuy}>{pending?'بانتظار الدفع':'شراء وتثبيت'}</button>}
    </footer>
  </article>;
}

function Empty(){
  return <div className={styles.empty}><span>⌕</span><h2>لا توجد نتائج مطابقة</h2><p>جرّب قسمًا آخر أو غيّر عبارة البحث.</p></div>;
}
