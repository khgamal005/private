'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './platform-commerce.module.css';
import PlatformServiceHub,{ProviderPublication,ServiceSetup} from './platform-service-hub';
import {ServiceDetails,OrderThread} from './service-hub-ui';
import {publicationReasons,safePortfolioUrl} from '../lib/service-hub.mjs';

const EMPTY=[];
const ORDER_STATUS={pending_payment:'بانتظار الدفع',paid:'مدفوع',in_progress:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي',refunded:'مسترد'};
const PROVIDER_TYPE={lecturer:'محاضر',trainer:'مدرب',consultant:'مستشار',freelancer:'مستقل',agency:'وكالة',company:'شركة'};
const AVAILABILITY={available:'متاح',limited:'متاح جزئيًا',unavailable:'غير متاح'};
const DELIVERY={online:'عن بُعد',onsite:'حضوري',hybrid:'هجين',recorded:'مسجل'};
const SERVICE_ACTION={save:'save_service',legacySave:'save_service_product'};
const money=(minor,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency,maximumFractionDigits:2}).format((Number(minor)||0)/100);
const date=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeZone:'Asia/Riyadh'}).format(new Date(value)):'—';
const values=value=>String(value||'').split(/[\n،,]/).map(item=>item.trim()).filter(Boolean);
const initials=value=>String(value||'مز').trim().split(/\s+/).slice(0,2).map(item=>item[0]).join('');
const statusLabel=value=>({active:'نشط',draft:'مسودة',beta:'تجريبي',paused:'موقوف',archived:'مؤرشف'}[value]||value);

function Modal({title,description,onClose,children,wide=true}){
  return <div className={styles.modalLayer}>
    <button className={styles.backdrop} type="button" aria-label="إغلاق" onClick={onClose}/>
    <section className={styles.modal+' '+(wide?styles.wideModal:'')} role="dialog" aria-modal="true">
      <header><div><h2>{title}</h2><p>{description}</p></div><button type="button" className={styles.close} onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>;
}

export default function PlatformServices({initialData}){
  const router=useRouter();
  const [tab,setTab]=useState('catalog');
  const [preview,setPreview]=useState(null),[threadOrder,setThreadOrder]=useState(null);
  const hub=initialData?.hub||{};
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const categories=initialData?.serviceCategories||EMPTY;
  const providers=initialData?.providers||EMPTY;
  const courses=initialData?.courses||EMPTY;
  const services=initialData?.services||EMPTY;
  const [deliveryOrder,setDeliveryOrder]=useState(null);
  const [deliveryReference,setDeliveryReference]=useState('');
  const orders=(initialData?.orders||EMPTY).filter(order=>!order.kind||order.kind==='service');
  const packages=useMemo(()=>services.flatMap(service=>(service.packages||EMPTY).map(item=>({...item,serviceId:service.id,serviceKey:service.key,serviceName:service.name,providerName:service.provider?.name||'فريق المنصة'}))),[services]);
  const source={catalog:services,providers,courses,packages,categories,orders}[tab]||EMPTY;
  const needle=query.trim().toLocaleLowerCase('ar');
  const rows=source.filter(item=>!needle||[
    item.name,item.key,item.title,item.categoryName,item.providerName,item.serviceName,
    item.orderNumber,item.tenantName,item.contact?.email,item.contact?.phone,
    ...(item.expertise||EMPTY),...(item.items||EMPTY).map(entry=>entry.name)
  ].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle)));
  const activeProviders=providers.filter(item=>item.status==='active');
  const summary=initialData?.summary||{};

  async function api(path,action,payload){
    const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data;
  }
  async function submit(key,action,payload,message,path='/api/platform/service-marketplace'){
    setBusy(key);setError('');setNotice('');
    try{await api(path,action,payload);setModal(null);setNotice(message);router.refresh()}
    catch(err){setError(err instanceof Error?err.message:'تعذر تنفيذ العملية')}
    finally{setBusy('')}
  }
  async function saveProvider(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('provider','save_provider',{
      providerId:item?.id||null,expectedUpdatedAt:item?.updatedAt||null,key:form.get('key'),
      type:form.get('type'),name:form.get('name'),nameEn:form.get('name_en'),title:form.get('title'),
      shortBio:form.get('short_bio'),bio:form.get('bio'),avatarUrl:form.get('avatar_url'),coverUrl:form.get('cover_url'),
      city:form.get('city'),countryCode:form.get('country_code')||'SA',nationality:form.get('nationality'),
      yearsExperience:form.get('years_experience'),languages:values(form.get('languages')),
      expertise:values(form.get('expertise')),verificationStatus:form.get('verification_status'),
      availabilityStatus:form.get('availability_status'),status:form.get('status'),featured:form.has('featured'),
      displayOrder:Number(form.get('display_order')||100),
      contact:{email:form.get('email'),phone:form.get('phone'),whatsapp:form.get('whatsapp'),websiteUrl:form.get('website_url'),linkedinUrl:form.get('linkedin_url'),internalNotes:form.get('internal_notes')}
    },'تم حفظ ملف مزود الخدمة وبياناته الخاصة.');
  }
  async function saveCourse(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('course','save_course',{
      courseId:item?.id||null,expectedUpdatedAt:item?.updatedAt||null,providerId:form.get('provider_id'),
      key:form.get('key'),title:form.get('title'),titleEn:form.get('title_en'),summary:form.get('summary'),
      targetAudience:form.get('target_audience'),objectives:values(form.get('objectives')),
      durationHours:form.get('duration_hours'),deliveryModes:Object.keys(DELIVERY).filter(mode=>form.has('mode_'+mode)),
      language:form.get('language'),accreditation:form.get('accreditation'),imageUrl:form.get('image_url'),
      status:form.get('status'),displayOrder:Number(form.get('display_order')||100)
    },'تم حفظ الدورة وربطها بمزود الخدمة.');
  }
  async function saveService(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('service',SERVICE_ACTION.save,{
      productId:item?.id||null,expectedUpdatedAt:item?.updatedAt||null,key:form.get('key'),name:form.get('name'),
      description:form.get('description'),shortDescription:form.get('short_description'),
      categoryId:form.get('category_id'),providerId:form.get('provider_id')||null,courseId:form.get('course_id')||null,
      pricingMode:form.get('pricing_mode'),amountMinor:Math.round(Number(form.get('amount')||0)*100),currency:'SAR',
      unitLabel:form.get('unit_label'),turnaroundDays:form.get('turnaround_days')||null,badge:form.get('badge'),
      imageUrl:form.get('image_url'),marketplaceVisible:form.has('marketplace_visible'),featured:form.has('featured'),
      status:form.get('status'),displayOrder:Number(form.get('display_order')||100)
    },'تم حفظ الخدمة وإعدادات ظهورها دون التأثير على الطلبات السابقة.');
  }
  async function savePackage(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('package','save_package',{
      packageId:item?.id||null,expectedUpdatedAt:item?.updatedAt||null,productId:form.get('product_id'),
      key:form.get('key'),name:form.get('name'),description:form.get('description'),
      amountMinor:Math.round(Number(form.get('amount')||0)*100),currency:'SAR',
      turnaroundDays:form.get('turnaround_days')||null,includedItems:values(form.get('included_items')),
      revisionsIncluded:Number(form.get('revisions_included')||0),recommended:form.has('recommended'),
      status:form.get('status'),displayOrder:Number(form.get('display_order')||100)
    },'تم حفظ باقة الخدمة.');
  }
  async function saveCategory(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('category','save_service_category',{categoryId:item?.id||null,key:form.get('key'),name:form.get('name'),description:form.get('description'),iconKey:form.get('icon_key'),displayOrder:Number(form.get('display_order')||100)},'تم حفظ قسم الخدمات.','/api/platform/commerce');
  }
  async function assignOrder(event){
    event.preventDefault();const form=new FormData(event.currentTarget);const item=modal.item;
    await submit('assignment','assign_order',{
      orderId:item.id,providerId:form.get('provider_id'),packageId:item.packageId||null,
      dueAt:form.get('due_at')?new Date(form.get('due_at')).toISOString():null,
      reason:form.get('reason'),expectedUpdatedAt:item.assignmentUpdatedAt||null
    },'تم إسناد الطلب وتسجيل العملية في سجل التغييرات.');
  }
  async function updateOrder(order,status){
    setBusy(order.id);setError('');setNotice('');
    try{await api('/api/platform/marketplace','update_service_status',{orderId:order.id,status});setNotice(status==='in_progress'?'تم بدء تنفيذ الخدمة.':'تم إغلاق الخدمة كمكتملة.');router.refresh()}
    catch(err){setError(err instanceof Error?err.message:'تعذر تحديث الطلب')}
    finally{setBusy('')}
  }

  const tabs=[['catalog','كتالوج الخدمات'],['providers','مقدمو الخدمات'],['courses','الدورات والمحاضرات'],['packages','الباقات والأسعار'],['categories','الأقسام'],['orders','الطلبات والتنفيذ'],...(hub.enabled?[['quotes','عروض الأسعار'],['applications','طلبات الانضمام ('+(hub.applicationCount||0)+')'],['reviews','التقييمات']]:[])];
  return <section className={styles.page}>
    <header className={styles.hero}><div><small>MANAGED SERVICES MARKETPLACE</small><h1>إدارة متجر الخدمات</h1><p>مركز موحد لإدارة المحاضرين والمستقلين والدورات والخدمات والباقات، ثم متابعة الطلب من الشراء حتى الإسناد والتسليم.</p></div><div className={styles.heroActions}><button className={styles.ghost} onClick={()=>setModal({type:'provider'})}>+ مزود خدمة</button><button className={styles.ghost} data-block-reason="أضف مقدم خدمة أولًا لربط الدورة به." disabled={!providers.length} onClick={()=>setModal({type:'course'})}>+ دورة</button><button className={styles.primary} onClick={()=>setModal({type:'service'})}>+ خدمة</button></div></header>
    <section className={styles.kpis}><article><span>مقدمو الخدمات</span><b>{summary.providerCount??providers.length}</b><small>{summary.activeProviders??activeProviders.length} نشط</small></article><article><span>مزودون موثقون</span><b>{summary.verifiedProviders??providers.filter(item=>item.verified).length}</b><small>تظهر شارة التوثيق للمنشآت</small></article><article><span>خدمات منشورة</span><b>{summary.publishedServices??services.filter(item=>item.marketplaceVisible&&['active','beta'].includes(item.status)).length}</b><small>الظهور مستقل عن النشاط</small></article><article><span>طلبات قيد التنفيذ</span><b>{summary.openServiceOrders??orders.filter(item=>['paid','in_progress'].includes(item.status)).length}</b><small>مدفوعة أو بدأت</small></article></section>
    {notice&&<div className={styles.notice} role="status">{notice}</div>}{error&&<div className={styles.error} role="alert">{error}</div>}
    {hub.unavailable&&<p className={styles.error} role="status">تعذر تحميل طلبات الانضمام وعروض الأسعار مؤقتًا. إدارة الكتالوج والطلبات الحالية متاحة.</p>}
    <nav className={styles.tabs}>{tabs.map(([key,label])=><button type="button" key={key} className={tab===key?styles.active:''} onClick={()=>{setTab(key);setQuery('')}}>{label}</button>)}</nav>
    {hub.enabled&&['quotes','applications','reviews'].includes(tab)&&<PlatformServiceHub key={tab} hub={hub} mode={tab} providers={providers} services={services} onEditProvider={id=>{const item=providers.find(p=>p.id===id);setTab('providers');if(item)setModal({type:'provider',item});}}/>}
    {!['quotes','applications','reviews'].includes(tab)&&<div className={styles.toolbar}><div className={styles.toolbarTitle}><b>{tabs.find(item=>item[0]===tab)?.[1]}</b><small>{rows.length} سجل</small></div><div className={styles.heroActions}>{tab==='packages'&&<button className={styles.ghost} data-block-reason="أضف خدمة أولًا لربط الباقة بها." disabled={!services.length} onClick={()=>setModal({type:'package'})}>+ باقة</button>}{tab==='categories'&&<button className={styles.ghost} onClick={()=>setModal({type:'category'})}>+ قسم</button>}<input className={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder="بحث بالاسم أو المزود أو الطلب…"/></div></div>}

    {tab==='providers'&&<section className={styles.providerGrid}>{rows.map(item=><article className={styles.provider} key={item.id}><header><i>{initials(item.name)}</i><span className={item.verified?styles.verified:styles.status}>{item.verified?'موثق':item.verificationStatus==='pending'?'قيد التوثيق':'غير موثق'}</span></header><div><h3>{item.name}</h3><p>{item.title||PROVIDER_TYPE[item.type]}</p></div><p>{item.shortBio||'لم تُضف نبذة مختصرة بعد.'}</p><dl><div><dt>التوفر</dt><dd>{AVAILABILITY[item.availabilityStatus]}</dd></div><div><dt>الخدمات / الدورات</dt><dd>{item.serviceCount||0} / {item.courseCount||0}</dd></div><div><dt>تواصل داخلي</dt><dd>{item.contact?.phone||item.contact?.email||'غير مسجل'}</dd></div></dl><footer><b>{(item.expertise||EMPTY).slice(0,2).join(' • ')||'مزود خدمة'}</b><button className={styles.ghost} onClick={()=>setModal({type:'provider',item})}>تعديل الملف</button></footer>{hub.enabled&&<ProviderPublication provider={item} hub={hub}/>}</article>)}{!rows.length&&<Empty text="لا يوجد مقدمو خدمات مطابقون."/>}</section>}
    {tab==='catalog'&&<DataTable headers={['الخدمة','المزود / الدورة','السعر والباقات','الظهور','الإجراء']} rows={rows.map(item=>[<div key="a"><b>{item.name}</b><small>{item.categoryName} • {item.key}</small></div>,<div key="b"><b>{item.provider?.name||'فريق المنصة'}</b><small>{item.courseTitle||item.provider?.title||'بدون دورة'}</small></div>,<div key="c"><b>{item.pricingMode==='quote'?'حسب عرض السعر':money(item.amountMinor,item.currency)}</b><small>{item.packages?.length||0} باقة</small></div>,<div key="d"><span className={styles.status+' '+(item.marketplaceVisible?styles.active:styles.draft)}>{publicationReasons(item,categories,providers).length?'غير ظاهر':'ظاهر في المتجر'}</span><small>{publicationReasons(item,categories,providers).join(' · ')||statusLabel(item.status)}</small></div>,<div className={styles.actions} key="e"><button onClick={()=>setPreview(item)}>معاينة</button><button onClick={()=>setModal({type:'service',item})}>تعديل</button><button onClick={()=>setModal({type:'package',service:item})}>+ باقة</button></div>])}/>}
    {tab==='courses'&&<DataTable headers={['الدورة','المحاضر / المزود','المدة والتقديم','الحالة','الإجراء']} rows={rows.map(item=>[<div key="a"><b>{item.title}</b><small>{item.key}</small></div>,<div key="b"><b>{item.providerName}</b><small>{item.accreditation||'دون اعتماد مسجل'}</small></div>,<div key="c"><b>{item.durationHours?item.durationHours+' ساعة':'غير محددة'}</b><small>{(item.deliveryModes||EMPTY).map(mode=>DELIVERY[mode]).join('، ')}</small></div>,<div key="d"><span className={styles.status+' '+(styles[item.status]||'')}>{statusLabel(item.status)}</span></div>,<div className={styles.actions} key="e"><button onClick={()=>setModal({type:'course',item})}>تعديل</button></div>])}/>}
    {tab==='packages'&&<DataTable headers={['الباقة','الخدمة','السعر','المحتوى','الإجراء']} rows={rows.map(item=>[<div key="a"><b>{item.name}</b><small>{item.key}{item.recommended?' • موصى بها':''}</small></div>,<div key="b"><b>{item.serviceName}</b><small>{item.providerName}</small></div>,<div key="c"><b>{money(item.amountMinor,item.currency)}</b><small>{item.turnaroundDays?item.turnaroundDays+' يوم':'حسب الاتفاق'}</small></div>,<div key="d"><b>{item.includedItems?.length||0} بنود</b><small>{item.revisionsIncluded||0} مراجعات</small></div>,<div className={styles.actions} key="e"><button onClick={()=>setModal({type:'package',item})}>تعديل</button></div>])}/>}
    {tab==='categories'&&<section className={styles.categoryGrid}>{rows.map(item=><article className={styles.category} key={item.id}><header><i>{item.iconKey?.slice(0,2)||'خ'}</i><span className={styles.status+' '+(styles[item.status]||'')}>{item.status==='active'?'نشط':'مخفي'}</span></header><h3>{item.name}</h3><p>{item.description||'قسم خدمات مُدار'}</p><footer><b>{item.productCount||0} خدمة</b><button className={styles.ghost} onClick={()=>setModal({type:'category',item})}>تعديل</button></footer></article>)}{!rows.length&&<Empty text="لا توجد أقسام."/>}</section>}
    {tab==='orders'&&<section className={styles.orders}><div className={styles.orderHeader}><span>الطلب</span><span>المنشأة</span><span>المزود والتسليم</span><span>الحالة والقيمة</span><span>الإجراء</span></div>{rows.map(order=><div className={styles.order} key={order.id}><div><b>{order.orderNumber}</b><small>{order.items?.map(item=>item.name).join('، ')||'طلب خدمة'}</small></div><div><b>{order.tenantName}</b><small>{date(order.createdAt)}</small></div><div><b>{order.providerName||'لم يُسند بعد'}</b><small>{order.dueAt?'التسليم '+date(order.dueAt):'دون موعد'}</small></div><div><span className={styles.status+' '+(styles[order.status]||'')}>{ORDER_STATUS[order.status]||order.status}</span><small>{money(order.totalMinor,order.currency)}</small>{order.paymentProvider==='tamara'&&<small>{order.tamaraStatus==='authorised'?'تمارا: بانتظار تأكيد التسليم':order.tamaraStatus==='provisioned'?'تمارا: يجري التحقق من التحصيل':order.tamaraStatus==='review_required'?'تمارا: تحتاج مراجعة الدفع':'تمارا'}{order.tamaraDeadline?' · المهلة '+date(order.tamaraDeadline):''}</small>}</div><div className={styles.actions}>{hub.enabled&&<button onClick={()=>setThreadOrder(order)}>المتابعة والمرفقات</button>}{['paid','in_progress'].includes(order.status)&&<button onClick={()=>setModal({type:'assignment',item:order})}>{order.providerId?'تغيير الإسناد':'إسناد مزود'}</button>}{order.status==='paid'&&<button disabled={busy===order.id} onClick={()=>updateOrder(order,'in_progress')}>بدء التنفيذ</button>}{order.status==='in_progress'&&<button disabled={busy===order.id||(order.paymentProvider==='tamara'&&order.tamaraStatus!=='authorised')} onClick={()=>{if(order.paymentProvider==='tamara'){setDeliveryOrder(order);setDeliveryReference('');}else updateOrder(order,'completed');}}>تأكيد التسليم</button>}</div></div>)}{!rows.length&&<Empty text="لا توجد طلبات خدمات."/>}</section>}

    {preview&&<ServiceDetails item={preview} onClose={()=>setPreview(null)}/>}
    {threadOrder&&<OrderThread order={threadOrder} onClose={()=>setThreadOrder(null)}/>}
    {modal?.type==='provider'&&<Modal onClose={()=>setModal(null)} title={modal.item?'تعديل ملف مزود الخدمة':'إضافة مزود خدمة'} description="الملف العام يظهر في المتجر، أما التواصل والملاحظات فتبقى داخل لوحة المنصة."><form className={styles.form} onSubmit={saveProvider}>
      <Field label="المفتاح الإنجليزي"><input name="key" pattern="[a-z][a-z0-9_]{2,80}" defaultValue={modal.item?.key||''} disabled={Boolean(modal.item)} required/></Field><Field label="النوع"><select name="type" defaultValue={modal.item?.type||'lecturer'}>{Object.entries(PROVIDER_TYPE).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label="الاسم الظاهر"><input name="name" defaultValue={modal.item?.name||''} required/></Field><Field label="المسمى المهني"><input name="title" defaultValue={modal.item?.title||''}/></Field><Field label="الاسم بالإنجليزية"><input name="name_en" defaultValue={modal.item?.nameEn||''}/></Field><Field label="المدينة"><input name="city" defaultValue={modal.item?.city||''}/></Field>
      <Field label="الجنسية"><input name="nationality" defaultValue={modal.item?.nationality||''}/></Field><Field label="سنوات الخبرة"><input name="years_experience" type="number" min="0" max="80" defaultValue={modal.item?.yearsExperience??''}/></Field><Field label="رمز الدولة"><input name="country_code" defaultValue={modal.item?.countryCode||'SA'}/></Field><Field label="اللغات"><input name="languages" defaultValue={(modal.item?.languages||['العربية']).join('، ')}/></Field>
      <Field label="الخبرات والتخصصات" wide><input name="expertise" defaultValue={(modal.item?.expertise||EMPTY).join('، ')}/></Field><Field label="نبذة مختصرة" wide><textarea name="short_bio" maxLength="500" defaultValue={modal.item?.shortBio||''}/></Field><Field label="السيرة المهنية" wide><textarea name="bio" maxLength="4000" defaultValue={modal.item?.bio||''}/></Field>
      <Field label="رابط الصورة الشخصية"><input name="avatar_url" type="url" defaultValue={safePortfolioUrl(modal.item?.avatarUrl)}/></Field><Field label="رابط صورة الغلاف"><input name="cover_url" type="url" defaultValue={modal.item?.coverUrl||''}/></Field><Field label="التوثيق"><select name="verification_status" defaultValue={modal.item?.verificationStatus||'unverified'}><option value="unverified">غير موثق</option><option value="pending">قيد التوثيق</option><option value="verified">موثق</option><option value="rejected">مرفوض</option></select></Field><Field label="التوفر"><select name="availability_status" defaultValue={modal.item?.availabilityStatus||'available'}>{Object.entries(AVAILABILITY).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="الحالة"><StatusSelect name="status" value={modal.item?.status}/></Field><Field label="ترتيب العرض"><input name="display_order" type="number" defaultValue={modal.item?.displayOrder??100}/></Field><label className={styles.check}><input name="featured" type="checkbox" defaultChecked={Boolean(modal.item?.featured)}/> مزود مميز</label>
      <div className={styles.wide}><b>بيانات داخلية لا تظهر للمنشآت</b></div><Field label="البريد"><input name="email" type="email" defaultValue={modal.item?.contact?.email||''}/></Field><Field label="الهاتف"><input name="phone" defaultValue={modal.item?.contact?.phone||''}/></Field><Field label="واتساب"><input name="whatsapp" defaultValue={modal.item?.contact?.whatsapp||''}/></Field><Field label="الموقع"><input name="website_url" type="url" defaultValue={modal.item?.contact?.websiteUrl||''}/></Field><Field label="LinkedIn" wide><input name="linkedin_url" type="url" defaultValue={modal.item?.contact?.linkedinUrl||''}/></Field><Field label="ملاحظات داخلية" wide><textarea name="internal_notes" defaultValue={modal.item?.contact?.internalNotes||''}/></Field><Footer busy={busy==='provider'} onClose={()=>setModal(null)} label="حفظ المزود"/>
    </form></Modal>}

    {modal?.type==='course'&&<Modal onClose={()=>setModal(null)} title={modal.item?'تعديل الدورة':'إضافة دورة أو محاضرة'} description="اربط المحتوى بالمحاضر حتى يظهر الملفان معًا في المتجر."><form className={styles.form} onSubmit={saveCourse}>
      <Field label="المزود"><select name="provider_id" defaultValue={modal.item?.providerId||providers[0]?.id||''} required>{providers.filter(item=>item.status!=='archived').map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="المفتاح الإنجليزي"><input name="key" pattern="[a-z][a-z0-9_]{2,80}" defaultValue={modal.item?.key||''} disabled={Boolean(modal.item)} required/></Field><Field label="اسم الدورة"><input name="title" defaultValue={modal.item?.title||''} required/></Field><Field label="الاسم بالإنجليزية"><input name="title_en" defaultValue={modal.item?.titleEn||''}/></Field><Field label="المدة بالساعات"><input name="duration_hours" type="number" min=".5" step=".5" defaultValue={modal.item?.durationHours||''}/></Field><Field label="اللغة"><input name="language" defaultValue={modal.item?.language||'العربية'}/></Field><Field label="الاعتماد"><input name="accreditation" defaultValue={modal.item?.accreditation||''}/></Field><Field label="رابط الصورة"><input name="image_url" type="url" defaultValue={modal.item?.imageUrl||''}/></Field><Field label="الحالة"><StatusSelect name="status" value={modal.item?.status}/></Field><Field label="ترتيب العرض"><input name="display_order" type="number" defaultValue={modal.item?.displayOrder??100}/></Field><Field label="نبذة عن الدورة" wide><textarea name="summary" minLength="10" maxLength="2000" defaultValue={modal.item?.summary||''} required/></Field><Field label="الفئة المستهدفة" wide><textarea name="target_audience" defaultValue={modal.item?.targetAudience||''}/></Field><Field label="الأهداف — هدف في كل سطر" wide><textarea name="objectives" defaultValue={(modal.item?.objectives||EMPTY).join('\n')}/></Field><div className={styles.wide}>{Object.entries(DELIVERY).map(([key,label])=><label className={styles.check} key={key}><input type="checkbox" name={'mode_'+key} defaultChecked={(modal.item?.deliveryModes||['online']).includes(key)}/>{label}</label>)}</div><Footer busy={busy==='course'} onClose={()=>setModal(null)} label="حفظ الدورة"/>
    </form></Modal>}

    {modal?.type==='service'&&<Modal onClose={()=>setModal(null)} title={modal.item?'تعديل الخدمة':'إضافة خدمة'} description="حدد المحتوى ومقدم الخدمة والتسعير، ثم راجع جاهزية النشر."><ServiceSetup item={modal.item} categories={categories} providers={providers} courses={courses} error={error} onSubmit={saveService} onClose={()=>setModal(null)} busy={busy==='service'}/></Modal>}

    {modal?.type==='package'&&<Modal onClose={()=>setModal(null)} title={modal.item?'تعديل الباقة':'إضافة باقة'} description="حدد نطاقًا وسعرًا ومدة واضحة لكل باقة."><form className={styles.form} onSubmit={savePackage}>
      <Field label="الخدمة"><select name="product_id" defaultValue={modal.item?.serviceId||modal.service?.id||services[0]?.id||''} disabled={Boolean(modal.item)} required>{services.filter(item=>item.status!=='archived').map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>{modal.item&&<input type="hidden" name="product_id" value={modal.item.serviceId}/>}</Field><Field label="المفتاح الإنجليزي"><input name="key" pattern="[a-z][a-z0-9_]{1,60}" defaultValue={modal.item?.key||''} disabled={Boolean(modal.item)} required/></Field><Field label="اسم الباقة"><input name="name" defaultValue={modal.item?.name||''} required/></Field><Field label="السعر بالريال"><input name="amount" type="number" min=".01" step=".01" defaultValue={(Number(modal.item?.amountMinor)||0)/100} required/></Field><Field label="مدة التنفيذ"><input name="turnaround_days" type="number" min="0" max="365" defaultValue={modal.item?.turnaroundDays||''}/></Field><Field label="عدد المراجعات"><input name="revisions_included" type="number" min="0" max="100" defaultValue={modal.item?.revisionsIncluded??0}/></Field><Field label="الحالة"><StatusSelect name="status" value={modal.item?.status}/></Field><Field label="ترتيب العرض"><input name="display_order" type="number" defaultValue={modal.item?.displayOrder??100}/></Field><label className={styles.check}><input name="recommended" type="checkbox" defaultChecked={Boolean(modal.item?.recommended)}/> الباقة الموصى بها</label><Field label="الوصف" wide><textarea name="description" defaultValue={modal.item?.description||''}/></Field><Field label="المشمول — بند في كل سطر" wide><textarea name="included_items" defaultValue={(modal.item?.includedItems||EMPTY).join('\n')}/></Field><Footer busy={busy==='package'} onClose={()=>setModal(null)} label="حفظ الباقة"/>
    </form></Modal>}

    {modal?.type==='category'&&<Modal onClose={()=>setModal(null)} wide={false} title={modal.item?'تعديل القسم':'قسم خدمات جديد'} description="القسم يظهر داخل متجر الخدمات فقط."><form className={styles.form} onSubmit={saveCategory}><Field label="المفتاح"><input name="key" pattern="[a-z][a-z0-9_]{2,60}" defaultValue={modal.item?.key||''} disabled={Boolean(modal.item)} required/></Field><Field label="الاسم"><input name="name" defaultValue={modal.item?.name||''} required/></Field><Field label="رمز الأيقونة"><input name="icon_key" defaultValue={modal.item?.iconKey||'services'}/></Field><Field label="الترتيب"><input name="display_order" type="number" defaultValue={modal.item?.displayOrder??100}/></Field><Field label="الوصف" wide><textarea name="description" defaultValue={modal.item?.description||''}/></Field><Footer busy={busy==='category'} onClose={()=>setModal(null)} label="حفظ القسم"/></form></Modal>}
    {modal?.type==='assignment'&&<Modal onClose={()=>setModal(null)} wide={false} title={'إسناد الطلب '+modal.item.orderNumber} description="اختر مزودًا نشطًا وحدد موعد التسليم؛ باقة الشراء لا تتغير."><form className={styles.form} onSubmit={assignOrder}><Field label="مزود الخدمة"><select name="provider_id" defaultValue={modal.item.providerId||''} required><option value="" disabled>اختر المزود</option>{activeProviders.map(item=><option key={item.id} value={item.id}>{item.name} — {AVAILABILITY[item.availabilityStatus]}</option>)}</select></Field><Field label="موعد التسليم"><input name="due_at" type="datetime-local" defaultValue={modal.item.dueAt?new Date(modal.item.dueAt).toISOString().slice(0,16):''}/></Field><Field label="سبب الإسناد أو التغيير" wide><textarea name="reason" maxLength="1000" placeholder="مثال: تخصص المزود وتوفره في الموعد"/></Field><div className={styles.hint}>بيانات التواصل الخاصة بالمزود لا تظهر للمنشأة، وكل إعادة إسناد محفوظة في سجل مستقل.</div><Footer busy={busy==='assignment'} onClose={()=>setModal(null)} label="تأكيد الإسناد"/></form></Modal>}
    {deliveryOrder&&<Modal title="تأكيد تسليم الخدمة" description="سيبدأ تحصيل تمارا بعد حفظ تأكيد التسليم. راجع التنفيذ الفعلي وأدخل مرجع التسليم." onClose={()=>setDeliveryOrder(null)}><form onSubmit={async event=>{event.preventDefault();setBusy(deliveryOrder.id);setError('');try{await api('/api/platform/tamara-service-delivery','confirm_delivery',{orderId:deliveryOrder.id,reference:deliveryReference});setDeliveryOrder(null);setNotice('تم تأكيد التسليم؛ يجري التحقق من تحصيل تمارا.');router.refresh();}catch(error){setError(error.message||'تعذر تأكيد التسليم');}finally{setBusy('');}}}><label>مرجع التسليم<input required minLength={5} maxLength={1000} value={deliveryReference} onChange={event=>setDeliveryReference(event.target.value)}/></label><button type="submit" disabled={Boolean(busy)}>تأكيد التسليم وبدء التحصيل</button></form></Modal>}
  </section>;
}

function DataTable({headers,rows}){
  return <section className={styles.panel}><div className={styles.table}><div className={styles.tableHeader}>{headers.map(item=><span key={item}>{item}</span>)}</div>{rows.map((cells,index)=><div className={styles.tableRow} key={index}>{cells}</div>)}{!rows.length&&<Empty text="لا توجد نتائج مطابقة."/>}</div></section>;
}
function Field({label,wide=false,children}){return <label className={styles.field+' '+(wide?styles.wide:'')}><span>{label}</span>{children}</label>}
function StatusSelect({name,value,kind='managed'}){return <select name={name} defaultValue={value||'draft'}><option value="draft">مسودة</option>{kind==='service'&&<option value="beta">تجريبي</option>}<option value="active">نشط</option>{kind!=='service'&&<option value="paused">موقوف</option>}<option value="archived">مؤرشف</option></select>}
function Footer({busy,onClose,label}){return <footer className={styles.formFooter}><button type="button" className={styles.ghost} onClick={onClose}>إلغاء</button><button className={styles.secondary} disabled={busy}>{label}</button></footer>}
function Empty({text}){return <div className={styles.empty}>{text}</div>}


