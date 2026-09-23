'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {businessDateTimeToInstant} from '../lib/task-timing.mjs';
import {safeTrainingExternalUrl} from '../lib/training-journey-contract';
import {installmentIssues} from '../lib/academy-delivery.mjs';
import styles from './academy-authoring.module.css';
const money=(value,currency)=>new Intl.NumberFormat('ar-SA',{style:'currency',currency}).format(value/100);
const date=(value,timeZone='Asia/Riyadh')=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short',timeZone}).format(new Date(value)):'تعلم ذاتي مستمر';
function Field({label,children}){return <label className={styles.field}><span>{label}</span>{children}</label>;}

export default function AcademyCourseDelivery({slug,courseId,learningMode}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [selection,setSelection]=useState('');const commands=useRef(new Map()),active=useRef(false);
  async function request(action,payload,signal) {
    const key=JSON.stringify([action,payload]);let commandId=commands.current.get(key);
    if(!commandId){commandId=crypto.randomUUID();commands.current.set(key,commandId);}
    const response=await fetch(`/api/academy-delivery/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,commandId,payload}),signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'تعذر تحميل إعدادات البيع.');
    if(action==='snapshot')commands.current.delete(key);return result;
  }
  useEffect(()=>{
    const controller=new AbortController();
    void request('snapshot',{courseId},controller.signal).then(setData).catch(failure=>{if(failure.name!=='AbortError')setError(failure.message);});
    return ()=>controller.abort();
  // Identity determines this panel; refreshes after writes are explicit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[slug,courseId]);
  async function act(action,payload) {
    if(active.current)return;active.current=true;setBusy(true);setError('');setNotice('');
    try {
      const result=await request(action,payload);
      setData(await request('snapshot',{courseId}));
      commands.current.delete(JSON.stringify([action,payload]));
      if(result.runId)setSelection(result.runId);
      setNotice(action==='create_run'?'أُنشئت الدفعة في سجل أودير. حدد سعرها وأضف لقاءاتها.':action==='assign_instructor'?'حُفظ إسناد المحاضر للدفعة.':action==='save_offer'?'حُفظت شروط البيع للتسجيلات الجديدة. الطلبات السابقة تحتفظ بشروطها.':payload.published?'الدورة ظاهرة في المتجر لهذه الدفعة.':'أُخفي خيار التسجيل من المتجر.');
    }catch(failure){setError(failure.message);}finally{active.current=false;setBusy(false);}
  }
  if(!data)return <section className={styles.panel}><h2>البيع والدفعات</h2>{error?<p className={styles.error} role="alert">{error}</p>:<p role="status">جارٍ تحميل خيارات الدورة…</p>}</section>;
  if(!data.available)return null;
  const mode=learningMode==='self_paced'?'self_paced':'cohort';
  const runs=data.runs.filter(run=>run.selfPaced===(mode==='self_paced'));
  const run=runs.find(item=>item.id===selection)||runs[0];
  const offer=data.offers.find(item=>item.runId===run?.id);
  return <section className={styles.panel} aria-busy={busy}><div className={styles.sectionHead}><div><h2>البيع والدفعات</h2><p>الدورة هي المنتج. اختر طريقة التسجيل والسعر، ثم أظهرها في المتجر. تعتمد الخيارات على آخر بيانات حفظتها للدورة.</p></div><Link className={styles.secondary} href={`/site/${slug}/courses`} target="_blank" rel="noopener noreferrer">عرض المتجر ↗</Link></div>
    <div className={styles.actions}><span className={`${styles.badge} ${data.contentPublished?styles.published:styles.draft}`}>المحتوى: {data.contentPublished?'منشور':'مسودة'}</span><span className={`${styles.badge} ${offer?.published?styles.published:styles.draft}`}>المتجر: {offer?.published?'ظاهر':'غير ظاهر'}</span></div>
    {error&&<p className={styles.error} role="alert">{error}</p>}{notice&&<p className={styles.notice} role="status">{notice}</p>}
    {!data.financeReady&&<p className={styles.hint}>أكمل إعدادات العملة والضريبة في أودير قبل حفظ شروط البيع.</p>}
    {mode==='cohort'&&<><Field label="الدفعة من التسجيل والقبول"><select value={run?.id||''} onChange={event=>setSelection(event.target.value)} disabled={busy}><option value="" disabled>اختر دفعة</option>{runs.map(item=><option key={item.id} value={item.id}>{item.title} · {date(item.startsAt,data.timezone)}</option>)}</select></Field><p className={styles.muted}>تظهر للطالب مواعيد ورابط Zoom الخاصان بدفعته، وتتحدث تلقائيًا من أودير.</p><Link className={styles.secondary} href={`/academy/${slug}/schedule`}>إدارة الدفعات واللقاءات</Link></>}
    {mode==='cohort'&&data.canManageStore&&<CreateRun courseId={courseId} data={data} busy={busy} act={act}/>}
    {(mode==='self_paced'||run)&&<SellingForm key={`${run?.id||'new'}:${offer?.version||0}`} courseId={courseId} run={run} offer={offer} data={data} mode={mode} busy={busy} act={act}/>}
    {run&&data.canManageInstructors&&<InstructorAssignment key={run.id} courseId={courseId} run={run} data={data} busy={busy} act={act} slug={slug}/>}
    {run?.sessions?.length>0&&<details className={styles.deliverySessions}><summary>لقاءات هذه الدفعة وروابطها ({run.sessions.length})</summary><ul>{run.sessions.map(session=><li key={session.id}><div><strong>{session.title}</strong><p>{date(session.startsAt,data.timezone)}</p></div>{session.status==='cancelled'?<span className={styles.badge}>ملغى</span>:safeTrainingExternalUrl(session.joinUrl)?<a href={safeTrainingExternalUrl(session.joinUrl)} className={styles.secondary} target="_blank" rel="noopener noreferrer">فتح اللقاء ↗</a>:<span className={styles.muted}>الرابط لم يُجهز بعد</span>}</li>)}</ul></details>}
  </section>;
}

function SellingForm({courseId,run,offer,data,mode,busy,act}) {
  const [free,setFree]=useState(offer?.netMinor===0),[price,setPrice]=useState(offer?String(offer.netMinor/100):'');
  const [terms,setTerms]=useState(offer?.installmentTerms||[]),[error,setError]=useState('');
  const net=free?0:Math.round(Number(price)*100),total=net+Math.round(net*data.taxRateBps/10000);
  const issues=installmentIssues(free?[]:terms,total),canSave=data.canManageStore&&data.financeReady&&!busy;
  function patch(index,changes){setTerms(values=>values.map((item,i)=>i===index?{...item,...changes}:item));}
  return <form className={styles.stack} onSubmit={event=>{event.preventDefault();if(issues.length){setError(issues[0]);return;}setError('');void act('save_offer',{courseId,runId:run?.id||null,learningMode:mode,expectedVersion:offer?.version||0,netMinor:net,installmentTerms:free?[]:terms});}}>
    <div className={styles.formGrid}><Field label="نوع التسجيل"><select value={free?'free':'paid'} onChange={event=>setFree(event.target.value==='free')} disabled={!canSave}><option value="paid">دورة مدفوعة</option><option value="free">دورة مجانية</option></select></Field>{!free&&<Field label={`السعر قبل الضريبة (${data.currency})`}><input type="number" value={price} min="0.01" max="1000000" step="0.01" required disabled={!canSave} onChange={event=>setPrice(event.target.value)}/></Field>}</div>
    <p className={styles.muted}>{free?'تسجيل مجاني، دون تحصيل مبلغ.':`الإجمالي شامل الضريبة: ${money(total,data.currency)} · شراء مرة واحدة`}</p>
    {!free&&<details open={terms.length>0}><summary>إتاحة التقسيط</summary><p className={styles.muted}>القسط الأول عند التسجيل. متابعة السداد والمهلة والشهادة تخضع لسياسة أودير.</p>{terms.map((item,i)=><div className={styles.installmentRow} key={i}><Field label={`قيمة القسط ${i+1}`}><input type="number" min="0.01" step="0.01" value={item.amountMinor/100} required disabled={!canSave} onChange={event=>patch(i,{amountMinor:Math.round(Number(event.target.value)*100)})}/></Field><Field label="بعد التسجيل بالأيام"><input type="number" min={i===0?0:1} max={730} value={item.dueDays} required disabled={!canSave||i===0} onChange={event=>patch(i,{dueDays:Number(event.target.value)})}/></Field><button type="button" className={styles.quiet} disabled={!canSave} onClick={()=>setTerms(values=>values.filter((_,index)=>index!==i))}>حذف</button></div>)}<div className={styles.actions}><button type="button" className={styles.secondary} disabled={!canSave||terms.length>=12} onClick={()=>setTerms(values=>values.length?[...values,{amountMinor:0,dueDays:values.at(-1).dueDays+30}]:[{amountMinor:Math.ceil(total/2),dueDays:0},{amountMinor:Math.floor(total/2),dueDays:30}])}>{terms.length?'إضافة قسط':'إضافة خطة تقسيط'}</button>{terms.length>0&&<button type="button" className={styles.quiet} disabled={!canSave} onClick={()=>setTerms([])}>إلغاء التقسيط</button>}</div></details>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}><button className={styles.primary} disabled={!canSave}>حفظ شروط البيع</button>{offer&&<button type="button" className={styles.secondary} disabled={busy||!data.canManageStore||(!offer.published&&!data.contentPublished)} onClick={()=>void act('publish_offer',{offerId:offer.id,expectedVersion:offer.version,published:!offer.published})}>{offer.published?'إخفاء من المتجر':'إظهار في المتجر'}</button>}</div>
    {!data.contentPublished&&<small className={styles.muted}>يمكن حفظ السعر الآن. انشر محتوى الدورة قبل إظهارها للطلاب.</small>}
  </form>;
}

function InstructorAssignment({courseId,run,data,busy,act,slug}) {
 const [subjectId,setSubjectId]=useState('');
 return <details className={styles.deliverySessions}><summary>محاضرو هذه الدفعة ({run.instructors?.length||0})</summary>
  {!!run.instructors?.length&&<ul>{run.instructors.map(person=><li key={person.subjectId}><strong>{person.name}</strong><button type="button" className={styles.quiet} disabled={busy} onClick={()=>void act('assign_instructor',{courseId,runId:run.id,subjectId:person.subjectId,active:false})}>إلغاء الإسناد</button></li>)}</ul>}
  <form className={styles.toolbar} onSubmit={event=>{event.preventDefault();void act('assign_instructor',{courseId,runId:run.id,subjectId,active:true});}}><Field label="إضافة محاضر للدفعة"><select required value={subjectId} onChange={event=>setSubjectId(event.target.value)} disabled={busy}><option value="">اختر حساب محاضر</option>{(data.instructorCandidates||[]).filter(person=>!run.instructors?.some(item=>item.subjectId===person.subjectId)).map(person=><option key={person.subjectId} value={person.subjectId}>{person.name}</option>)}</select></Field><button className={styles.secondary} disabled={busy||!subjectId}>إسناد المحاضر</button></form>
  <Link className={styles.quiet} href={`/academy/${slug}/people`}>إضافة محاضر أو إدارة حسابه</Link>
 </details>;
}

function CreateRun({courseId,data,busy,act}) {
 const [error,setError]=useState('');
 return <details className={styles.deliverySessions}><summary>إضافة دفعة جديدة لهذه الدورة</summary><form className={styles.stack} onSubmit={event=>{
  event.preventDefault();const fields=Object.fromEntries(new FormData(event.currentTarget));setError('');
  try {const startsAt=businessDateTimeToInstant(fields.startsAt,data.timezone),endsAt=businessDateTimeToInstant(fields.endsAt,data.timezone);if(!startsAt||!endsAt||Date.parse(endsAt)<=Date.parse(startsAt))throw Error('حدد بداية ونهاية صحيحتين للدفعة.');void act('create_run',{courseId,title:fields.title,deliveryMode:fields.deliveryMode,capacity:Number(fields.capacity),startsAt,endsAt});}catch(failure){setError(failure.message);}
 }}><p className={styles.muted}>المواعيد بتوقيت المنشأة ({data.timezone}). تحفظ الدفعة في التسجيل والقبول نفسه.</p><div className={styles.formGrid}>
  <Field label="اسم الدفعة"><input name="title" required minLength={2} maxLength={200} disabled={busy} placeholder="مثال: دفعة أكتوبر المسائية"/></Field>
  <Field label="طريقة الحضور"><select name="deliveryMode" disabled={busy}><option value="online">عن بعد</option><option value="onsite">حضوري</option><option value="hybrid">حضوري وعن بعد</option></select></Field>
  <Field label="بداية الدفعة"><input name="startsAt" type="datetime-local" required disabled={busy}/></Field><Field label="نهاية الدفعة"><input name="endsAt" type="datetime-local" required disabled={busy}/></Field>
  <Field label="عدد المقاعد"><input name="capacity" type="number" min="1" max="10000" defaultValue="20" required disabled={busy}/></Field>
 </div>{error&&<p role="alert" className={styles.error}>{error}</p>}<div><button className={styles.secondary} disabled={busy}>إنشاء الدفعة</button></div></form></details>;
}
