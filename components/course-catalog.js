'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import WooCommerceSyncPanel from './woocommerce-sync-panel';

const deliveryLabels={
  online:'عن بُعد',
  onsite:'حضوري',
  hybrid:'هجين'
};

const categoryLabels={
  project_management:'إدارة المشاريع',
  technology:'التقنية والذكاء الاصطناعي',
  data_analytics:'البيانات والتحليلات',
  management:'الإدارة والأداء',
  productivity:'الإنتاجية',
  human_resources:'الموارد البشرية',
  general:'عام'
};

export default function CourseCatalog({
  slug,
  initialData,
  commerceData,
  canManage,
  canManageCommerce
}){
  const router=useRouter();
  const [category,setCategory]=useState('all');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const courses=useMemo(()=>{
    const commerceById=new Map(
      (commerceData?.courses||[]).map(item=>[
        item.id||item.courseId,
        item
      ])
    );
    return (initialData.services||[]).map(item=>({
      ...item,
      ...(commerceById.get(item.id)||{})
    }));
  },[initialData.services,commerceData?.courses]);
  const categories=[...new Set(courses.map(item=>item.category).filter(Boolean))];
  const shown=useMemo(()=>courses.filter(item=>{
    const matchesCategory=category==='all'||item.category===category;
    const haystack=`${item.nameAr||''} ${item.nameEn||''} ${item.courseCode||''}`;
    return matchesCategory&&haystack.toLowerCase().includes(query.toLowerCase());
  }),[courses,category,query]);
  const completedDurations=courses.filter(item=>item.durationHours||item.durationDays).length;
  const priced=courses.filter(item=>item.priceMinor!==null&&item.priceMinor!==undefined).length;
  const onSale=courses.filter(item=>saleActive(item)).length;
  const wooConnected=Boolean(commerceData?.connection);

  async function createCourse(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const response=await fetch('/api/tenant/create-course',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_title_ar:values.title_ar,
          p_title_en:values.title_en||null,
          p_course_code:values.course_code,
          p_category:values.category,
          p_delivery_mode:values.delivery_mode,
          p_duration_hours:values.duration_hours?Number(values.duration_hours):null,
          p_duration_days:values.duration_days?Number(values.duration_days):null,
          p_description:values.description||null,
          p_certification_code:values.certification_code||null,
          p_price_minor:values.price?Math.round(Number(values.price)*100):null
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر إنشاء الدورة');
      setMessage('تم إنشاء الدورة وإضافتها إلى كتالوج ريف');
      setModal(false);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>ACADEMY CATALOG</small>
        <h2>متجر البرامج والدورات</h2>
        <p>كتالوج موحّد للدورات والأسعار والعروض، مرتبط بالدفعات والتسجيل والقبول والمبيعات.</p>
      </div>
      <div className="mt-page-actions">
        {canManage&&<button className="mt-button primary" onClick={()=>setModal(true)}>+ دورة جديدة</button>}
      </div>
    </header>

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}
    <WooCommerceSyncPanel
      slug={slug}
      initialData={commerceData}
      canManage={canManageCommerce}
    />
    <section className="mt-data-note">
      {wooConnected
        ?<div>
          <b>WooCommerce هو مصدر البيانات التجارية</b>
          <p>السعر والعرض والصور والمخزون تتحدث من المتجر، بينما تظل الدفعات والتشغيل والاعتماد داخل ماركتون.</p>
        </div>
        :<div>
          <b>الأسعار والجداول لم تُخترع</b>
          <p>أدخل الدورات والمدد المؤكدة، أو اربط WooCommerce لنقل الأسعار والعروض تلقائيًا.</p>
        </div>}
      <span>{wooConnected?'متزامن':'بيانات دقيقة'}</span>
    </section>

    <section className="mt-kpis">
      <article className="mt-kpi"><span>الدورات النشطة</span><b>{courses.length}</b><small>برامج في الكتالوج</small></article>
      <article className="mt-kpi"><span>مدد مكتملة</span><b>{completedDurations}</b><small>من {courses.length} دورات</small></article>
      <article className="mt-kpi"><span>أسعار معتمدة</span><b>{priced}</b><small>{wooConnected?'قادمة من المتجر':'من الكتالوج الحالي'}</small></article>
      <article className="mt-kpi"><span>عروض فعالة</span><b>{onSale}</b><small>أسعار مخفضة سارية الآن</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={category==='all'?'active':''} onClick={()=>setCategory('all')}>الكل</button>
          {categories.map(item=><button
            className={category===item?'active':''}
            onClick={()=>setCategory(item)}
            key={item}
          >{categoryLabels[item]||item}</button>)}
        </div>
        <input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث باسم الدورة أو الكود"/>
      </div>

      <div className="mt-course-grid">
        {shown.map(item=><article className="mt-course-card" key={item.id}>
          <header>
            <span>{item.courseCode}</span>
            <div className="mt-course-card-status">
              {item.externalSource==='woocommerce'&&<em className="mt-woo-badge">Woo</em>}
              <em className="mt-status active">{item.status==='active'?'نشطة':item.status}</em>
            </div>
          </header>
          <div>
            <small>{categoryLabels[item.category]||item.category}</small>
            <h3>{item.nameAr}</h3>
            {item.nameEn&&<p className="latin-text">{item.nameEn}</p>}
            <p>{item.description||'لم يضف وصف بعد.'}</p>
          </div>
          <dl>
            <div><dt>طريقة التقديم</dt><dd>{deliveryLabels[item.deliveryMode]||item.deliveryMode}</dd></div>
            <div><dt>المدة</dt><dd>{durationLabel(item)}</dd></div>
            <div><dt>الاعتماد</dt><dd>{item.certificationCode||'لا يوجد كود محدد'}</dd></div>
            <div><dt>السعر</dt><dd><CoursePrice item={item}/></dd></div>
          </dl>
          {item.externalUrl&&<footer className="mt-course-commerce-footer">
            <small>آخر تحديث: {shortDate(item.externalUpdatedAt)}</small>
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >فتح في المتجر</a>
          </footer>}
        </article>)}
        {!shown.length&&<div className="mt-empty">لا توجد دورات مطابقة.</div>}
      </div>
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createCourse}>
        <header><div><small>COURSE CATALOG</small><h3>إضافة دورة تدريبية</h3></div><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">اسم الدورة بالعربية<input name="title_ar" required/></label>
          <label className="mt-field">كود الدورة<input name="course_code" dir="ltr" required/></label>
          <label className="mt-field">الاسم بالإنجليزية<input name="title_en" dir="ltr"/></label>
          <label className="mt-field">التصنيف<select name="category" defaultValue="general">
            {Object.entries(categoryLabels).map(([value,label])=><option value={value} key={value}>{label}</option>)}
          </select></label>
          <label className="mt-field">طريقة التقديم<select name="delivery_mode" defaultValue="hybrid">
            <option value="hybrid">هجين</option><option value="online">عن بُعد</option><option value="onsite">حضوري</option>
          </select></label>
          <label className="mt-field">عدد الساعات<input name="duration_hours" type="number" min="0.5" step=".5"/></label>
          <label className="mt-field">عدد الأيام<input name="duration_days" type="number" min="1"/></label>
          <label className="mt-field">كود الاعتماد<input name="certification_code" dir="ltr"/></label>
          <label className="mt-field">السعر بالريال — اختياري<input name="price" type="number" min="0" step=".01"/></label>
          <label className="mt-field wide">الوصف<textarea name="description" rows="4"/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button>
          <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'إضافة إلى الكتالوج'}</button>
        </footer>
      </form>
    </div>}
  </>;
}

function durationLabel(item){
  if(!item.durationHours&&!item.durationDays)return 'تحدد لاحقًا';
  const parts=[];
  if(item.durationHours)parts.push(`${Number(item.durationHours)} ساعة`);
  if(item.durationDays)parts.push(`${item.durationDays} أيام`);
  return parts.join(' · ');
}

function priceLabel(item){
  if(item.priceMinor===null||item.priceMinor===undefined)return 'يحدد لاحقًا';
  const minorDigits=Number.isInteger(Number(item.currencyMinorDigits))
    ?Math.min(4,Math.max(0,Number(item.currencyMinorDigits)))
    :2;
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:item.currency||'SAR',
    minimumFractionDigits:minorDigits,
    maximumFractionDigits:minorDigits
  }).format(Number(item.priceMinor)/(10**minorDigits));
}

function CoursePrice({item}){
  const regular=item.regularPriceMinor;
  if(saleActive(item)&&regular!==null&&regular!==undefined){
    return <span className="mt-course-sale-price">
      <b>{priceLabel(item)}</b>
      <s>{priceLabel({...item,priceMinor:regular})}</s>
    </span>;
  }
  return priceLabel(item);
}

function saleActive(item){
  if(item.salePriceMinor===null||item.salePriceMinor===undefined)return false;
  const now=Date.now();
  const from=item.saleStartsAt?Date.parse(item.saleStartsAt):null;
  const to=item.saleEndsAt?Date.parse(item.saleEndsAt):null;
  return (!from||from<=now)&&(!to||to>=now);
}

function shortDate(value){
  if(!value)return 'غير محدد';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return 'غير محدد';
  return date.toLocaleDateString('ar-SA');
}
