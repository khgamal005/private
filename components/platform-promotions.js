'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-promotions.module.css';

const EMPTY=[];
const STATUS_LABEL={draft:'مسودة',active:'نشط',paused:'متوقف',archived:'مؤرشف'};
const KIND_LABEL={addon:'الإضافات',service:'الخدمات'};
const PAYMENT_LABEL={paymob:'Paymob',bank_transfer:'التحويل البنكي'};

function money(value){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency:'SAR',maximumFractionDigits:2
  }).format((Number(value)||0)/100);
}
function asRiyals(minor){return minor==null?'':String(Number(minor)/100);}
function minor(value){
  if(value===''||value==null)return null;
  const number=Number(value);
  return Number.isFinite(number)?Math.round(number*100):null;
}
function localDateTime(value){
  if(!value)return '';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return shifted.toISOString().slice(0,16);
}
function statusTone(status){return styles['status_'+status]||'';}
function blankPromotion(){
  const start=new Date(Date.now()-new Date().getTimezoneOffset()*60000)
    .toISOString().slice(0,16);
  return {
    id:null,code:'',name:'',description:'',status:'draft',
    discountType:'percentage',discountPercent:'10',fixedAmount:'',
    maximumDiscount:'',minimumSubtotal:'0',budget:'',
    totalRedemptionLimit:'',perTenantLimit:'1',firstPurchaseOnly:false,
    startsAt:start,endsAt:'',orderKinds:['addon','service'],
    productKeys:[],tenantIds:[],paymentProviders:[],reservationMinutes:'30'
  };
}
function editPromotion(item){
  return {
    id:item.id,code:item.code||'',name:item.name||'',description:item.description||'',
    status:item.status||'draft',discountType:item.discountType||'percentage',
    discountPercent:item.discountType==='percentage'
      ?String((Number(item.discountValue)||0)/100):'10',
    fixedAmount:item.discountType==='fixed'?asRiyals(item.discountValue):'',
    maximumDiscount:asRiyals(item.maximumDiscountMinor),
    minimumSubtotal:asRiyals(item.minimumSubtotalMinor)||'0',
    budget:asRiyals(item.budgetMinor),
    totalRedemptionLimit:item.totalRedemptionLimit==null?'':String(item.totalRedemptionLimit),
    perTenantLimit:item.perTenantLimit==null?'':String(item.perTenantLimit),
    firstPurchaseOnly:Boolean(item.firstPurchaseOnly),
    startsAt:localDateTime(item.startsAt),endsAt:localDateTime(item.endsAt),
    orderKinds:item.orderKinds||['addon','service'],
    productKeys:item.productKeys||[],tenantIds:item.tenantIds||[],
    paymentProviders:item.paymentProviders||[],
    reservationMinutes:String(item.reservationMinutes||30),
    usageTotal:(Number(item.usage?.reserved)||0)+(Number(item.usage?.redeemed)||0)+(Number(item.usage?.released)||0)
  };
}

export default function PlatformPromotions({initialData}){
  const router=useRouter();
  const data=initialData||{};
  const promotions=data.promotions||EMPTY;
  const tenants=data.tenants||EMPTY;
  const products=data.products||EMPTY;
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [editor,setEditor]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  const visible=useMemo(()=>{
    const needle=query.trim().toLowerCase();
    return promotions.filter(item=>(filter==='all'||item.status===filter)
      &&(!needle||[item.code,item.name,item.description].some(value=>
        String(value||'').toLowerCase().includes(needle)
      )));
  },[promotions,filter,query]);

  async function act(action,payload){
    const response=await fetch('/api/platform/promotions',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action,payload})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data||{};
  }

  async function save(event){
    event.preventDefault();
    if(!editor||busy)return;
    const discountValue=editor.discountType==='percentage'
      ?Math.round(Number(editor.discountPercent)*100)
      :minor(editor.fixedAmount);
    setBusy('save');setError('');setNotice('');
    try{
      await act('save_promotion',{
        id:editor.id||undefined,
        code:editor.code.trim().toUpperCase(),
        name:editor.name.trim(),description:editor.description.trim()||undefined,
        status:editor.status,discountType:editor.discountType,discountValue,
        maximumDiscountMinor:minor(editor.maximumDiscount),
        minimumSubtotalMinor:minor(editor.minimumSubtotal)||0,
        budgetMinor:minor(editor.budget),
        totalRedemptionLimit:editor.totalRedemptionLimit===''?null:Number(editor.totalRedemptionLimit),
        perTenantLimit:editor.perTenantLimit===''?null:Number(editor.perTenantLimit),
        firstPurchaseOnly:editor.firstPurchaseOnly,
        startsAt:new Date(editor.startsAt).toISOString(),
        endsAt:editor.endsAt?new Date(editor.endsAt).toISOString():null,
        orderKinds:editor.orderKinds,
        productKeys:editor.productKeys,
        tenantIds:editor.tenantIds,
        paymentProviders:editor.paymentProviders,
        reservationMinutes:Number(editor.reservationMinutes)
      });
      setEditor(null);setNotice('تم حفظ البرومو وتطبيق حالته مباشرة بصلاحية المستخدم الحالي.');
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر حفظ البرومو');}
    finally{setBusy('');}
  }

  async function setStatus(item,status){
    if(busy)return;
    setBusy('status-'+item.id);setError('');setNotice('');
    try{
      await act('set_status',{id:item.id,status});
      setNotice(status==='active'?'تم تفعيل البرومو مباشرة.':status==='paused'?'تم إيقاف البرومو.':'تمت أرشفة البرومو.');
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر تغيير حالة العرض');}
    finally{setBusy('');}
  }

  async function deleteDraft(item){
    if(busy||!confirm(`حذف المسودة ${item.code} نهائيًا؟`))return;
    setBusy('delete-'+item.id);setError('');setNotice('');
    try{
      await act('delete_draft',{id:item.id});
      setNotice('تم حذف مسودة البرومو.');router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر حذف المسودة');}
    finally{setBusy('');}
  }

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div><span>ODEIR COMMERCE</span><h1>العروض والبرومو كود</h1><p>خصومات خادمية مرتبطة بالطلب قبل Paymob، مع حدود استخدام وميزانية ونطاق واضح وسجل تدقيق كامل.</p></div>
      <button type="button" onClick={()=>setEditor(blankPromotion())}>إنشاء برومو جديد</button>
    </header>

    <section className={styles.kpis}>
      <article><small>إجمالي العروض</small><b>{data.summary?.total||0}</b></article>
      <article><small>العروض النشطة</small><b>{data.summary?.active||0}</b></article>
      <article><small>استخدامات ناجحة</small><b>{data.summary?.redeemed||0}</b></article>
      <article><small>إجمالي الخصومات</small><b>{money(data.summary?.discountMinor)}</b></article>
      <article><small>إيراد مرتبط بالعروض</small><b>{money(data.summary?.revenueMinor)}</b></article>
    </section>

    {notice&&<div className={styles.notice} role="status">{notice}</div>}
    {error&&<div className={styles.error} role="alert">{error}</div>}

    <section className={styles.toolbar}>
      <label><span>⌕</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالكود أو اسم العرض…"/></label>
      <div>{['all','active','draft','paused','archived'].map(value=><button type="button" key={value} className={filter===value?styles.selected:''} onClick={()=>setFilter(value)}>{value==='all'?'الكل':STATUS_LABEL[value]}</button>)}</div>
    </section>

    <section className={styles.list}>
      {visible.map(item=><article key={item.id}>
        <header><div><code>{item.code}</code><h2>{item.name}</h2></div><span className={[styles.status,statusTone(item.status)].join(' ')}>{STATUS_LABEL[item.status]||item.status}</span></header>
        <p>{item.description||'لا يوجد وصف داخلي.'}</p>
        <dl>
          <div><dt>الخصم</dt><dd>{item.discountType==='percentage'?`${Number(item.discountValue)/100}%`:money(item.discountValue)}</dd></div>
          <div><dt>الحد الأدنى</dt><dd>{money(item.minimumSubtotalMinor)}</dd></div>
          <div><dt>الاستخدام الناجح</dt><dd>{item.usage?.redeemed||0}</dd></div>
          <div><dt>المحجوز حاليًا</dt><dd>{item.usage?.reserved||0}</dd></div>
          <div><dt>الخصم المصروف</dt><dd>{money(item.usage?.discountMinor)}</dd></div>
          <div><dt>الصلاحية</dt><dd>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.startsAt))}{item.endsAt?' — '+new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.endsAt)):' — مفتوح'}</dd></div>
        </dl>
        <footer>
          <button type="button" onClick={()=>setEditor(editPromotion(item))}>تعديل</button>
          {item.status!=='active'&&item.status!=='archived'&&<button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={()=>void setStatus(item,'active')}>تفعيل</button>}
          {item.status==='active'&&<button type="button" disabled={Boolean(busy)} onClick={()=>void setStatus(item,'paused')}>إيقاف</button>}
          {item.status!=='archived'&&<button type="button" disabled={Boolean(busy)} onClick={()=>void setStatus(item,'archived')}>أرشفة</button>}
          {item.status==='draft'&&((item.usage?.reserved||0)+(item.usage?.redeemed||0)+(item.usage?.released||0)===0)&&<button type="button" className={styles.danger} disabled={Boolean(busy)} onClick={()=>void deleteDraft(item)}>حذف</button>}
        </footer>
      </article>)}
      {!visible.length&&<div className={styles.empty}><b>لا توجد عروض مطابقة</b><span>أنشئ أول برومو أو غيّر مرشح البحث.</span></div>}
    </section>

    {editor&&<PromotionModal value={editor} setValue={setEditor} tenants={tenants} products={products} busy={busy} onClose={()=>setEditor(null)} onSubmit={save}/>} 
  </main>;
}

function PromotionModal({value,setValue,tenants,products,busy,onClose,onSubmit}){
  const update=(key,next)=>setValue(current=>({...current,[key]:next}));
  const toggle=(key,item)=>setValue(current=>{
    const list=new Set(current[key]||EMPTY);
    if(list.has(item))list.delete(item);else list.add(item);
    return {...current,[key]:[...list].sort()};
  });
  const hasHistory=Boolean(value.id&&value.usageTotal>0);
  return <div className={styles.modalLayer}>
    <button type="button" className={styles.backdrop} aria-label="إغلاق" onClick={onClose}/>
    <form className={styles.modal} onSubmit={onSubmit} role="dialog" aria-modal="true">
      <header><div><small>تنفيذ مباشر للمستخدم المخوّل</small><h2>{value.id?'تعديل البرومو':'برومو جديد'}</h2></div><button type="button" onClick={onClose}>×</button></header>
      <div className={styles.formGrid}>
        <label><span>الكود</span><input dir="ltr" required minLength="3" maxLength="32" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" value={value.code} disabled={hasHistory} onChange={event=>update('code',event.target.value.toUpperCase())}/></label>
        <label><span>اسم العرض</span><input required minLength="2" maxLength="160" value={value.name} onChange={event=>update('name',event.target.value)}/></label>
        <label><span>الحالة</span><select value={value.status} onChange={event=>update('status',event.target.value)}><option value="draft">مسودة</option><option value="active">نشط مباشرة</option><option value="paused">متوقف</option><option value="archived">مؤرشف</option></select></label>
        <label><span>نوع الخصم</span><select value={value.discountType} disabled={hasHistory} onChange={event=>update('discountType',event.target.value)}><option value="percentage">نسبة مئوية</option><option value="fixed">مبلغ ثابت</option></select></label>
        {value.discountType==='percentage'?<label><span>نسبة الخصم %</span><input type="number" min="0.01" max="99.99" step="0.01" required value={value.discountPercent} disabled={hasHistory} onChange={event=>update('discountPercent',event.target.value)}/></label>:<label><span>قيمة الخصم بالريال</span><input type="number" min="0.01" step="0.01" required value={value.fixedAmount} disabled={hasHistory} onChange={event=>update('fixedAmount',event.target.value)}/></label>}
        <label><span>أقصى خصم بالريال <small>(اختياري)</small></span><input type="number" min="0.01" step="0.01" value={value.maximumDiscount} disabled={hasHistory} onChange={event=>update('maximumDiscount',event.target.value)}/></label>
        <label><span>الحد الأدنى للطلب</span><input type="number" min="0" step="0.01" value={value.minimumSubtotal} disabled={hasHistory} onChange={event=>update('minimumSubtotal',event.target.value)}/></label>
        <label><span>ميزانية الخصومات <small>(اختياري)</small></span><input type="number" min="0.01" step="0.01" value={value.budget} disabled={hasHistory} onChange={event=>update('budget',event.target.value)}/></label>
        <label><span>إجمالي الاستخدامات <small>(اختياري)</small></span><input type="number" min="1" step="1" value={value.totalRedemptionLimit} disabled={hasHistory} onChange={event=>update('totalRedemptionLimit',event.target.value)}/></label>
        <label><span>لكل منشأة <small>(اختياري)</small></span><input type="number" min="1" step="1" value={value.perTenantLimit} disabled={hasHistory} onChange={event=>update('perTenantLimit',event.target.value)}/></label>
        <label><span>بداية الصلاحية</span><input type="datetime-local" required value={value.startsAt} disabled={hasHistory} onChange={event=>update('startsAt',event.target.value)}/></label>
        <label><span>نهاية الصلاحية <small>(اختياري)</small></span><input type="datetime-local" value={value.endsAt} onChange={event=>update('endsAt',event.target.value)}/></label>
        <label><span>حجز الاستخدام بالدقائق</span><input type="number" min="5" max="1440" step="1" required value={value.reservationMinutes} disabled={hasHistory} onChange={event=>update('reservationMinutes',event.target.value)}/></label>
        <label className={styles.check}><input type="checkbox" checked={value.firstPurchaseOnly} disabled={hasHistory} onChange={event=>update('firstPurchaseOnly',event.target.checked)}/><span>أول عملية شراء للمنشأة فقط</span></label>
        <label className={styles.wide}><span>وصف داخلي <small>(اختياري)</small></span><textarea rows="2" maxLength="2000" value={value.description} onChange={event=>update('description',event.target.value)}/></label>
      </div>

      <Scope title="أنواع الطلبات" note="اختر نوعًا واحدًا على الأقل">
        {Object.entries(KIND_LABEL).map(([key,label])=><Check key={key} checked={value.orderKinds.includes(key)} label={label} disabled={hasHistory} onChange={()=>toggle('orderKinds',key)}/>) }
      </Scope>
      <Scope title="وسائل الدفع" note="عدم الاختيار يعني كل الوسائل">
        {Object.entries(PAYMENT_LABEL).map(([key,label])=><Check key={key} checked={value.paymentProviders.includes(key)} label={label} disabled={hasHistory} onChange={()=>toggle('paymentProviders',key)}/>) }
      </Scope>
      <Scope title="المنتجات المشمولة" note="عدم الاختيار يعني كل الإضافات والخدمات">
        <div className={styles.optionGrid}>{products.map(item=><Check key={item.kind+':'+item.key} checked={value.productKeys.includes(item.key)} label={`${item.name} · ${KIND_LABEL[item.kind]||item.kind}`} disabled={hasHistory} onChange={()=>toggle('productKeys',item.key)}/>)}</div>
      </Scope>
      <Scope title="المنشآت المشمولة" note="عدم الاختيار يعني جميع المنشآت المؤهلة">
        <div className={styles.optionGrid}>{tenants.map(item=><Check key={item.id} checked={value.tenantIds.includes(item.id)} label={`${item.name} · ${item.slug}`} disabled={hasHistory} onChange={()=>toggle('tenantIds',item.id)}/>)}</div>
      </Scope>

      {hasHistory&&<aside className={styles.warning}>بدأ استخدام العرض؛ تظل الشروط المالية والنطاق مقفلة ويُسمح فقط بتغيير الحالة والوصف ونهاية الصلاحية.</aside>}
      <footer><button type="button" onClick={onClose}>إلغاء</button><button type="submit" className={styles.primary} disabled={busy==='save'||!value.orderKinds.length}>{busy==='save'?'جارٍ التحقق والحفظ…':'حفظ مباشرة'}</button></footer>
    </form>
  </div>;
}
function Scope({title,note,children}){return <fieldset className={styles.scope}><legend>{title}</legend><small>{note}</small><div>{children}</div></fieldset>;}
function Check({checked,label,disabled=false,onChange}){return <label className={styles.check}><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange}/><span>{label}</span></label>;}
