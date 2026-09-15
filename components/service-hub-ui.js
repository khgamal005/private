'use client';
/* eslint-disable @next/next/no-img-element */

import {useEffect,useId,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {REQUEST_STATUS,safePortfolioUrl,canOrderDirectly} from '../lib/service-hub.mjs';
import {PaymentMethodPicker} from './payment-method-picker';
import s from './service-hub.module.css';

export const hubMoney=(minor,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency}).format((Number(minor)||0)/100);
export const hubDate=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'}).format(new Date(value)):'غير محدد';
const availability={available:'متاح',limited:'متاح جزئيًا',unavailable:'غير متاح حاليًا'};
const modes={online:'عن بُعد',onsite:'حضوري',hybrid:'مدمج',recorded:'مسجل'};

export async function hubCall(slug,action,payload={}){
  const response=await fetch(slug?'/api/tenant/service-hub':'/api/platform/service-hub',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug,action,payload})});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'تعذر تنفيذ العملية.');
  return result.data;
}
export function useHubAction(slug){
  const router=useRouter();const lock=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function run(action,payload,message){
    if(lock.current)return null;lock.current=true;setBusy(true);setError('');setNotice('');
    try{const data=await hubCall(slug,action,payload);if(message){setNotice(message);router.refresh();}return data;}
    catch(e){setError(e.message||'تعذر الاتصال.');return null;}
    finally{lock.current=false;setBusy(false);}
  }
  return {run,busy,error,notice};
}
export function HubFeedback({error,notice}){return <>{error&&<p className={s.error} role="alert">{error}</p>}{notice&&<p className={s.notice} role="status">{notice}</p>}</>;}
export function ServiceDialog({title,onClose,children}){
  const ref=useRef(null);const id=useId();
  useEffect(()=>{const dialog=ref.current;dialog.showModal();return ()=>dialog.close();},[]);
  return <dialog ref={ref} className={`${s.hub} ${s.dialog}`} aria-labelledby={id} onCancel={event=>{event.preventDefault();onClose();}}>
    <header><h2 id={id}>{title}</h2><button type="button" className={s.close} onClick={onClose} aria-label="إغلاق">×</button></header>{children}
  </dialog>;
}
export function HubPagination({page,total,busy,onPage}){
  if(total<=30)return null;
  return <nav className={s.pagination} aria-label="صفحات النتائج"><button type="button" data-block-reason={busy?'يجري تحميل النتائج.':'هذه هي الصفحة الأولى.'} disabled={busy||page===0} onClick={()=>onPage(page-1)}>السابق</button><span>{page+1} / {Math.ceil(total/30)}</span><button type="button" data-block-reason={busy?'يجري تحميل النتائج.':'هذه هي الصفحة الأخيرة.'} disabled={busy||(page+1)*30>=total} onClick={()=>onPage(page+1)}>التالي</button></nav>;
}
export function ExpertIdentity({expert}){
  const image=safePortfolioUrl(expert.avatarUrl);
  return <div className={s.identity}>{image?<img className={s.avatar} src={image} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<span className={s.avatar} aria-hidden="true">{expert.name?.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('')}</span>}<div><h3>{expert.name}</h3><p className={s.muted}>{expert.title}</p>{expert.verified&&<span className={`${s.badge} ${s.verified}`}>✓ موثّق</span>}</div></div>;
}
export function ExpertProfile({expert,onClose,onRequest}){
  return <ServiceDialog title="ملف الخبير" onClose={onClose}><div className={s.stack}>
    <ExpertIdentity expert={expert}/><p className={s.prose}>{expert.bio||expert.shortBio}</p>
    <div className={s.tags}>{(expert.expertise||[]).map((tag,i)=><span key={i}>{tag}</span>)}</div>
    <dl className={s.facts}><div><dt>سنوات الخبرة</dt><dd>{expert.yearsExperience??'غير محددة'}</dd></div><div><dt>المدينة</dt><dd>{expert.city||'غير محددة'}</dd></div><div><dt>اللغات</dt><dd>{expert.languages?.join('، ')||'غير محددة'}</dd></div><div><dt>التوفر</dt><dd>{availability[expert.availabilityStatus]||'يُنسّق عند الطلب'}</dd></div></dl>
    {expert.reviewCount>0&&<p>★ {expert.rating} من {expert.reviewCount} تقييمات لطلبات مكتملة</p>}
    {!!expert.courses?.length&&<section className={s.stack}><h3>الدورات والمحاضرات</h3>{expert.courses.map(course=><article className={s.card} key={course.id}><h3>{course.title}</h3><p>{course.summary}</p><small>{course.durationHours?`${course.durationHours} ساعة · `:''}{course.deliveryModes?.map(v=>modes[v]).join('، ')}</small></article>)}</section>}
    {onRequest&&<button className={s.primary} onClick={()=>onRequest(expert)}>طلب هذا الخبير</button>}
  </div></ServiceDialog>;
}
export function ExpertsPanel({hub,slug,onRequest}){
  const [query,setQuery]=useState(''),[available,setAvailable]=useState(''),[profile,setProfile]=useState(null),[paged,setPaged]=useState(null);
  const action=useHubAction(slug);const data=paged||hub;
  const experts=(data.experts||[]).filter(p=>(!available||p.availabilityStatus===available)&&(!query||[p.name,p.title,p.city,...(p.expertise||[])].join(' ').toLocaleLowerCase('ar').includes(query.toLocaleLowerCase('ar'))));
  return <section className={s.hub}><div className={s.filter}><input aria-label="البحث في خبراء الصفحة" placeholder="ابحث في هذه الصفحة بالاسم أو التخصص أو المدينة" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="التوفر" value={available} onChange={e=>setAvailable(e.target.value)}><option value="">كل حالات التوفر</option>{Object.entries(availability).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
    <HubFeedback {...action}/><div className={s.grid}>{experts.map(expert=><article className={s.card} key={expert.id}><ExpertIdentity expert={expert}/><p>{expert.shortBio}</p><div className={s.tags}>{expert.expertise?.slice(0,4).map((tag,i)=><span key={i}>{tag}</span>)}</div><p className={s.muted}>{expert.yearsExperience?`${expert.yearsExperience} سنوات خبرة · `:''}{expert.city} · {availability[expert.availabilityStatus]}</p><footer><button className={s.secondary} onClick={()=>setProfile(expert)}>عرض الملف</button>{onRequest&&<button className={s.primary} onClick={()=>onRequest(expert)}>طلب الخبير</button>}</footer></article>)}{!experts.length&&<div className={s.empty}><h3>لا يوجد خبراء مطابقون</h3><p>غيّر البحث أو التوفر، أو أرسل طلب خدمة مخصصة.</p></div>}</div>
    <HubPagination page={data.page||0} total={data.expertCount||0} busy={action.busy} onPage={async page=>{const next=await action.run('snapshot',{page});if(next)setPaged(next);}}/>
    {profile&&<ExpertProfile expert={profile} onClose={()=>setProfile(null)} onRequest={onRequest?expert=>{setProfile(null);onRequest(expert);}:null}/>}</section>;
}
export function ServiceDetails({item,onClose,onBuy,onQuote,canPurchase=true,pending=false}){
  const direct=canOrderDirectly(item),packages=item.packages||[];
  return <ServiceDialog title={item.name} onClose={onClose}><div className={s.stack}>
    <span className={s.badge}>{item.categoryName}</span><p className={s.prose}>{item.description||item.shortDescription}</p>
    {item.provider&&<ExpertIdentity expert={item.provider}/>}
    {item.course&&<section className={s.card}><h3>{item.course.title}</h3><p>{item.course.summary}</p><p>الفئة المستهدفة: {item.course.targetAudience||'تُحدد حسب احتياج المنشأة'}</p>{item.course.objectives?.length>0&&<ul>{item.course.objectives.map((v,i)=><li key={i}>{v}</li>)}</ul>}</section>}
    <dl className={s.facts}><div><dt>مدة البرنامج</dt><dd>{item.course?.durationHours?`${item.course.durationHours} ساعة`:'حسب نطاق الخدمة'}</dd></div><div><dt>مدة تجهيز وتسليم الخدمة</dt><dd>{item.turnaroundDays?`${item.turnaroundDays} أيام`:'حسب الاتفاق'}</dd></div><div><dt>التوفر الفعلي</dt><dd>{availability[item.provider?.availabilityStatus]||'يُؤكد عند تنسيق الموعد'}</dd></div></dl>
    {!!packages.length&&<div className={s.comparison}><table><caption>مقارنة الباقات — الأسعار قبل الضريبة</caption><thead><tr><th>الباقة</th><th>المخرجات</th><th>التسليم والمراجعات</th><th>السعر</th></tr></thead><tbody>{packages.map(pkg=><tr key={pkg.id}><th>{pkg.name}{pkg.recommended&&<small> · موصى بها</small>}</th><td>{pkg.description}<ul>{pkg.includedItems?.map((v,i)=><li key={i}>{v}</li>)}</ul></td><td>{pkg.turnaroundDays?`${pkg.turnaroundDays} أيام`:'حسب الاتفاق'}<br/>{pkg.revisionsIncluded||0} مراجعات</td><td>{hubMoney(pkg.amountMinor,pkg.currency)}</td></tr>)}</tbody></table></div>}
    <div className={s.actions}>{onBuy&&direct&&<button className={s.primary} data-block-reason={!canPurchase?'تحتاج صلاحية إدارة اشتراك المنشأة لطلب الخدمات.':'يوجد طلب دفع قائم لهذه الخدمة؛ تابعه من طلباتي.'} disabled={!canPurchase||pending} onClick={()=>onBuy(item)}>{pending?'يوجد طلب دفع قائم':'اختيار الباقة وطلب الخدمة'}</button>}{onQuote&&<button className={direct?s.secondary:s.primary} data-block-reason="تحتاج صلاحية إدارة اشتراك المنشأة لطلب الخدمات." disabled={!canPurchase} onClick={()=>onQuote(item)}>طلب عرض سعر</button>}</div>
  </div></ServiceDialog>;
}
export function QuoteRequest({slug,target={},onClose,onSent}){
  const action=useHubAction(slug);const [key]=useState(()=>crypto.randomUUID());const [mode,setMode]=useState('online');
  async function submit(event){event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget));const data=await action.run('request',{...form,requestKey:key,providerId:target.providerId||'',productId:target.productId||''},'تم إرسال الطلب للمراجعة.');if(data)onSent(data);}
  return <ServiceDialog title={target.name?`طلب عرض سعر: ${target.name}`:'اطلب خدمة مخصصة'} onClose={onClose}><form className={s.form} onSubmit={submit}>
    <p className={`${s.info} ${s.full}`}>اكتب احتياج منشأتك. ستراجع عرضًا يحدد المخرجات والسعر والموعد قبل إنشاء طلب الدفع.</p>
    <label className={s.full}>عنوان الطلب<input name="title" defaultValue={target.name||''} minLength={2} maxLength={180} required/></label>
    <label className={s.full}>الاحتياج والمخرجات المطلوبة<textarea name="details" minLength={10} maxLength={4000} required placeholder="الموضوع، الفئة المستهدفة، والنتيجة التي تريد تحقيقها…"/></label>
    <label>طريقة التنفيذ<select name="deliveryMode" value={mode} onChange={e=>setMode(e.target.value)}>{Object.entries(modes).filter(([k])=>k!=='recorded').map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
    <label>المدينة{mode!=='online'?' *':' (اختياري)'}<input name="city" minLength={2} maxLength={100} required={mode!=='online'}/></label>
    <label>التاريخ المفضل (اختياري)<input name="date" type="date"/></label><label>عدد المستفيدين (اختياري)<input name="participants" type="number" min="1" max="100000"/></label>
    <label className={s.full}>الميزانية التقريبية (اختياري)<input name="budget" maxLength={100} placeholder="مثال: من ٣٠٠٠ إلى ٥٠٠٠ ر.س."/></label>
    <div className={s.full}><HubFeedback {...action}/></div><div className={`${s.actions} ${s.full}`}><button className={s.primary} data-block-reason="يجري حفظ العملية؛ انتظر حتى تنتهي." disabled={action.busy}>{action.busy?'جارٍ الإرسال…':'إرسال طلب عرض السعر'}</button><button type="button" className={s.secondary} onClick={onClose}>رجوع</button></div>
  </form></ServiceDialog>;
}
export function QuoteSummary({request}){
  const offer=request.offer;
  return <div className={s.stack}><p className={s.prose}>{request.brief.details}</p><dl className={s.facts}><div><dt>طريقة التنفيذ</dt><dd>{modes[request.brief.deliveryMode]}</dd></div><div><dt>الموعد المفضل</dt><dd>{request.brief.date||'غير محدد'}</dd></div><div><dt>المدينة / العدد</dt><dd>{request.brief.city||'—'} / {request.brief.participants||'غير محدد'}</dd></div><div><dt>الميزانية التقريبية</dt><dd>{request.brief.budget||'غير محددة'}</dd></div></dl>
    {offer&&<section className={s.card}><h3>{offer.title}</h3><p className={s.prose}>{offer.scope}</p><p>التسليم: {offer.delivery||'غير محدد'}</p><p>المراجعات: {offer.revisions||'حسب النطاق'}</p>{offer.exclusions&&<p>لا يشمل: {offer.exclusions}</p>}<p>مقدم الخدمة: {request.providerName||'فريق المنصة'}</p><dl className={s.facts}><div><dt>السعر قبل الضريبة</dt><dd>{hubMoney(offer.amountMinor)}</dd></div><div><dt>الضريبة</dt><dd>{hubMoney(offer.taxMinor)}</dd></div><div><dt>الإجمالي</dt><dd>{hubMoney(offer.totalMinor)}</dd></div></dl><small>صالح حتى {hubDate(request.expiresAt)} بتوقيت الرياض · إصدار الطلب {request.version}</small></section>}
  </div>;
}
export function RequestsPanel({hub,slug,paymentMethods,onAccepted}){
  const action=useHubAction(slug);const [paged,setPaged]=useState(null),[selected,setSelected]=useState(null),[method,setMethod]=useState(''),[confirmed,setConfirmed]=useState(false),[openedAt,setOpenedAt]=useState(0);
  const data=paged||hub,methods=paymentMethods.filter(m=>['bank_transfer','paymob','tamara'].includes(m.key));
  async function refresh(){const next=await action.run('snapshot',{page:data.page||0});if(next)setPaged(next);}
  async function act(type){const result=await action.run(type,{id:selected.id,version:selected.version,paymentProvider:method},type==='accept'?'تم اعتماد العرض وإنشاء طلب الدفع.':'تم تحديث الطلب.');if(result){setSelected(null);await refresh();if(type==='accept')onAccepted(result);}}
  return <section className={`${s.hub} ${s.stack}`}><HubFeedback {...action}/><div className={s.grid}>{(data.requests||[]).map(request=><article className={s.card} key={request.id}><div className={s.requestHeader}><span className={s.badge}>{REQUEST_STATUS[request.status]}</span><small>{hubDate(request.createdAt)}</small></div><h3>{request.brief.title}</h3><p>{request.providerName||'طلب مخصص'}</p>{request.offer&&<b className={s.price}>{hubMoney(request.offer.totalMinor)}</b>}<button className={s.secondary} onClick={()=>{setSelected(request);setOpenedAt(Date.now());setConfirmed(false);setMethod(methods[0]?.key||'');}}>عرض التفاصيل{request.status==='offered'?' والموافقة':''}</button></article>)}{!data.requests?.length&&<div className={s.empty}><h3>لم ترسل طلبات عروض أسعار بعد</h3><p>اختر خدمة أو خبيرًا، أو أرسل طلبًا مخصصًا.</p></div>}</div>
    <HubPagination page={data.page||0} total={data.requestCount||0} busy={action.busy} onPage={async page=>{const next=await action.run('snapshot',{page});if(next)setPaged(next);}}/>
    {selected&&<ServiceDialog title={selected.brief.title} onClose={()=>setSelected(null)}><div className={s.stack}><QuoteSummary request={selected}/><HubFeedback {...action}/>
      {selected.status==='offered'&&Date.parse(selected.expiresAt)>openedAt?<><PaymentMethodPicker methods={methods} value={method} onChange={setMethod}/><p className={s.info}>تُثبت وسيلة الدفع عند اعتماد العرض. تبدأ عملية الدفع في خطوة منفصلة؛ ويمكنك إلغاء الطلب غير المدفوع من سجل الطلبات.</p><label className={s.check}><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> راجعت السعر شامل الضريبة والمخرجات وموعد التسليم وأوافق على العرض.</label><button className={s.primary} data-block-reason={action.busy?'يجري اعتماد العرض.':!method?'لا توجد وسيلة دفع متاحة لهذه المنشأة.':'راجع العرض ثم ضع علامة الموافقة على السعر والمخرجات.'} disabled={action.busy||!confirmed||!method} onClick={()=>act('accept')}>اعتماد العرض وإنشاء طلب الدفع</button></>:selected.status==='offered'?<p className={s.info}>انتهت صلاحية العرض؛ تواصل مع الإدارة لتجديده.</p>:null}
      {['requested','offered'].includes(selected.status)&&<div className={s.actions}><button className={s.secondary} data-block-reason="يجري حفظ العملية؛ انتظر حتى تنتهي." disabled={action.busy} onClick={()=>act(selected.status==='offered'?'decline':'cancel')}>{selected.status==='offered'?'رفض العرض':'إلغاء الطلب'}</button></div>}
      {selected.status==='accepted'&&<p className={s.notice}>تم ربط العرض بطلب الشراء. تابع الدفع والتنفيذ من سجل طلبات الخدمات.</p>}
    </div></ServiceDialog>}
  </section>;
}
const orderEvents={pending_payment:'بانتظار الدفع',paid:'تم الدفع',in_progress:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي',refunded:'مسترد'};
export function OrderThread({order,slug,onClose}){
  const action=useHubAction(slug);const [thread,setThread]=useState(null);const [key,setKey]=useState(()=>crypto.randomUUID());const [reviewed,setReviewed]=useState(false);const [reviewError,setReviewError]=useState('');const [reviewBusy,setReviewBusy]=useState(false);
  useEffect(()=>{let active=true;hubCall(slug,'order_thread',{orderId:order.id}).then(value=>{if(active)setThread(value);}).catch(()=>{if(active)setThread({error:true});});return ()=>{active=false;};},[slug,order.id]);
  async function submit(event){event.preventDefault();const form=event.currentTarget;const payload=Object.fromEntries(new FormData(form));const data=await action.run('order_note',{...payload,orderId:order.id,requestKey:key},'تمت إضافة التحديث.');if(data){form.reset();setKey(crypto.randomUUID());const next=await action.run('order_thread',{orderId:order.id});if(next)setThread(next);}}
  async function review(event){event.preventDefault();if(reviewBusy)return;setReviewBusy(true);setReviewError('');try{const payload=Object.fromEntries(new FormData(event.currentTarget));const response=await fetch('/api/tenant/service-marketplace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_slug:slug,p_action:'submit_review',p_payload:{orderId:order.id,...payload}})});const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر تسجيل التقييم. قد يكون للطلب تقييم سابق.');setReviewed(true);}catch(e){setReviewError(e.message);}finally{setReviewBusy(false);}}
  return <ServiceDialog title={`متابعة ${order.orderNumber||'الطلب'}`} onClose={onClose}><div className={s.stack}><ol className={s.stepList}>{['pending_payment','paid','in_progress','completed'].map(status=><li key={status} aria-current={order.status===status?'step':undefined}>{orderEvents[status]}</li>)}</ol><p>الحالة الحالية: {orderEvents[order.status]||order.status}</p>
    {!thread?<p role="status">جارٍ تحميل المتابعة…</p>:thread.error?<button className={s.secondary} onClick={async()=>{const data=await action.run('order_thread',{orderId:order.id});if(data)setThread(data);}}>تعذر التحميل — المحاولة مرة أخرى</button>:<><details><summary>سجل حالة الطلب</summary><ul className={s.timeline}>{thread.events?.map((e,i)=><li key={i}>{orderEvents[e.to_status]||'تحديث الطلب'} <small>{hubDate(e.created_at)}</small></li>)}</ul></details><ul className={s.timeline}>{thread.updates?.map(update=><li key={update.id}><b>{update.from_platform?'فريق أودير':'المنشأة'}</b> <small>{hubDate(update.created_at)}</small><p>{update.message}</p>{safePortfolioUrl(update.attachment_url)&&<a href={safePortfolioUrl(update.attachment_url)} target="_blank" rel="noreferrer">فتح المرفق</a>}</li>)}</ul>{!thread.updates?.length&&<p className={s.muted}>لا توجد رسائل متابعة حتى الآن.</p>}</>}
    <HubFeedback {...action}/><form className={s.form} onSubmit={submit}><label className={s.full}>تحديث أو ملاحظة<textarea name="message" minLength={2} maxLength={2000} required/></label><label className={s.full}>رابط مرفق (اختياري)<input name="attachmentUrl" type="url" pattern="https://.*" maxLength={2000} placeholder="https://" dir="ltr"/></label><button className={s.primary} data-block-reason="يجري حفظ العملية؛ انتظر حتى تنتهي." disabled={action.busy}>إضافة للمتابعة</button></form>
    {slug&&order.status==='completed'&&(reviewed?<p className={s.notice}>وصل تقييمك للمراجعة. شكرًا لمشاركتك.</p>:<form className={s.form} onSubmit={review}><h3 className={s.full}>قيّم تجربتك</h3><label>التقييم<select name="rating" required defaultValue=""><option value="" disabled>اختر التقييم</option>{[5,4,3,2,1].map(v=><option key={v} value={v}>{v} / 5</option>)}</select></label><label className={s.full}>تجربتك مع الخدمة<textarea name="reviewText" maxLength={2000}/></label>{reviewError&&<p role="alert" className={`${s.error} ${s.full}`}>{reviewError}</p>}<button className={s.primary} data-block-reason="يجري إرسال التقييم." disabled={reviewBusy}>إرسال التقييم للمراجعة</button></form>)}
  </div></ServiceDialog>;
}
