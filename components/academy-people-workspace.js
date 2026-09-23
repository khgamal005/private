'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import styles from './academy-authoring.module.css';
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
function Field({label,children}){return <label className={styles.field}><span>{label}</span>{children}</label>;}

export default function AcademyPeopleWorkspace({slug,initialData,canOpenOperations=false}) {
 const [data,setData]=useState(initialData),[kind,setKind]=useState('students'),[query,setQuery]=useState(''),[form,setForm]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[invitation,setInvitation]=useState(null),[copied,setCopied]=useState(false);
 const active=useRef(false),commands=useRef(new Map());
 async function request(action,payload) {
  const signature=JSON.stringify([action,payload]);let command=commands.current.get(signature);
  if(!command){command={id:crypto.randomUUID(),token:token()};commands.current.set(signature,command);}
  const response=await fetch(`/api/academy-people/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,commandId:command.id,payload:{...payload,...(action.startsWith('invite_')?{invitationToken:command.token}:{})}})});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'تعذر إكمال العملية.');commands.current.delete(signature);return value;
 }
 async function run(operation) {
  if(active.current)return;active.current=true;setBusy(true);setError('');setNotice('');
  try{return await operation();}catch(failure){setError(failure.message);}finally{active.current=false;setBusy(false);}
 }
 async function load(nextKind=kind,offset=0,nextQuery=query) {
  return run(async()=>{const next=await request('snapshot',{kind:nextKind,query:nextQuery,offset});setData(next);setKind(nextKind);setForm(false);});
 }
 async function action(name,payload) {
  return run(async()=>{
   const result=await request(name,payload);
   if(result.invitationUrl){setInvitation({url:new URL(result.invitationUrl,window.location.origin).href,email:payload.email});setCopied(false);}
   setData(await request('snapshot',{kind,query,offset:0}));setForm(false);
   setNotice(name==='add_student'?'تم ربط ملف الطالب بالمنصة وأودير. يمكنك إنشاء دعوة دخوله من بطاقته.':'أُنشئت دعوة آمنة لصاحب البريد.');return result;
  });
 }
 if(!data.available)return <section className={styles.panel} dir="rtl"><h1>الطلاب والمحاضرون</h1><p>يجري تجهيز إدارة الأشخاص وربطهم بأودير.</p></section>;
 const canAdd=kind==='students'?data.canAddStudents:data.canManageInstructors;
 return <div className={styles.workspace} dir="rtl" aria-busy={busy}><header className={styles.heading}><div><span className={styles.eyebrow}>ملف واحد لكل شخص</span><h1>الطلاب والمحاضرون</h1><p>إدارة الحسابات والدعوات، مع الحفاظ على ارتباطها بملفات أودير.</p></div>{canAdd&&<button type="button" className={styles.primary} disabled={busy} onClick={()=>setForm(value=>!value)}>{form?'إغلاق النموذج':kind==='students'?'+ إضافة طالب':'+ إضافة محاضر'}</button>}</header>
  {error&&<p className={styles.error} role="alert">{error}</p>}{notice&&<p className={styles.notice} role="status">{notice}</p>}
  {invitation&&<section className={styles.panel}><h2>دعوة {invitation.email}</h2><p className={styles.muted}>شارك الرابط مع صاحب البريد. يقبل الدعوة بعد تأكيد بريده وتسجيل دخوله.</p><Field label="رابط الدعوة"><input readOnly dir="ltr" value={invitation.url} onFocus={event=>event.target.select()}/></Field><div className={styles.actions}><button className={styles.secondary} onClick={async()=>{try{await navigator.clipboard.writeText(invitation.url);setCopied(true);}catch{setCopied(false);}}}>{copied?'تم نسخ الرابط':'نسخ الرابط'}</button><button className={styles.quiet} onClick={()=>setInvitation(null)}>إغلاق</button></div></section>}
  <nav className={styles.tabs} aria-label="الأشخاص">{[['students','الطلاب'],['instructors','المحاضرون']].map(([key,label])=><button key={key} type="button" disabled={busy} aria-current={key===kind?'page':undefined} onClick={()=>{setQuery('');void load(key,0,'');}}>{label}</button>)}</nav>
  {form&&<PersonForm key={kind} kind={kind} staff={data.staff||[]} busy={busy} onSubmit={payload=>action(kind==='students'?'add_student':'invite_instructor',payload)}/>}
  <form className={styles.toolbar} onSubmit={event=>{event.preventDefault();void load();}}><label className={styles.search}><span className={styles.srOnly}>البحث بالاسم أو البريد أو الجوال</span><input type="search" value={query} maxLength={100} placeholder="ابحث بالاسم أو البريد أو الجوال…" onChange={event=>setQuery(event.target.value)}/></label><button className={styles.secondary} disabled={busy}>بحث</button></form>
  {data.rows.length?<div className={styles.cards}>{data.rows.map(person=><article className={styles.courseCard} key={person.id}><div className={styles.row}><span className={`${styles.badge} ${person.accountStatus==='active'?styles.published:styles.draft}`}>{person.accountStatus==='active'?'حساب مرتبط':person.accountStatus==='suspended'?'الحساب موقوف':person.invitationPending?'دعوة بانتظار القبول':'لم يُفعّل الدخول'}</span><span className={styles.muted}>{kind==='students'?'طالب':'محاضر'}</span></div><h2>{person.name}</h2><p dir="ltr">{person.email}<br/>{person.phone}</p>{kind==='students'?<><p>{person.enrollmentCount} تسجيلات · المسؤول: {person.ownerName||'لم يُسند بعد'}</p><span className={styles.muted}>ملف الطالب مرتبط بسجل التواصل في أودير.</span>{data.canInviteStudents&&!person.accountStatus&&['active','graduated'].includes(person.status)&&<button className={styles.secondary} disabled={busy} onClick={()=>void action('invite_student',{studentId:person.id,email:person.email})}>{person.invitationPending?'إنشاء دعوة بديلة':'إنشاء دعوة دخول'}</button>}</>:<><p>{person.runCount} دفعات مسندة</p><span className={styles.muted}>{person.staffId?'مرتبط بملف محاضر في فريق أودير.':'حساب منصة قائم؛ اربط ملف الفريق عند الحاجة.'}</span>{data.canManageInstructors&&person.accountStatus!=='active'&&<button className={styles.secondary} disabled={busy} onClick={()=>void action('invite_instructor',{staffId:person.staffId||null,name:person.name,email:person.email,phone:person.phone||''})}>إنشاء دعوة دخول</button>}</>}
  </article>)}</div>:<section className={styles.empty}><h2>{query?'لا توجد نتائج مطابقة':kind==='students'?'سيظهر الطلاب هنا':'أضف أول محاضر'}</h2><p>{kind==='students'?'الطالب المقبول من أودير أو المتجر يظهر بنفس ملفه هنا.':'اربط ملفًا قائمًا من فريق أودير أو أضف محاضرًا جديدًا.'}</p></section>}
  {(data.offset>0||data.hasMore)&&<nav className={styles.pagination} aria-label="صفحات الأشخاص"><button className={styles.secondary} disabled={busy||data.offset===0} onClick={()=>void load(kind,Math.max(0,data.offset-50))}>السابق</button><button className={styles.secondary} disabled={busy||!data.hasMore} onClick={()=>void load(kind,data.offset+50)}>التالي</button></nav>}
  <div className={styles.actions}><Link className={styles.secondary} href={`/academy/${slug}/lms/learners`}>التسجيلات والتدريب</Link>{canOpenOperations&&<Link className={styles.secondary} href={`/tenant/${slug}/${kind==='students'?'admissions':'team'}`}>{kind==='students'?'القبول في أودير':'فريق أودير'}</Link>}</div>
 </div>;
}

function PersonForm({kind,staff,busy,onSubmit}) {
 const [staffId,setStaffId]=useState(''),[name,setName]=useState(''),[email,setEmail]=useState(''),[phone,setPhone]=useState('');
 return <section className={styles.panel}><h2>{kind==='students'?'إضافة طالب':'إضافة محاضر'}</h2><p className={styles.muted}>{kind==='students'?'نبحث عن ملف موجود بالجوال والبريد قبل إنشاء ملف جديد. إضافة الملف لا تعني تأكيد السداد أو التسجيل.':'يمكن للمحاضر استخدام حسابه الحالي. دعوة المحاضر تتيح التدريب وتربطه بملف الفريق.'}</p><form className={styles.stack} onSubmit={event=>{event.preventDefault();void onSubmit({name,email,phone,...(kind==='instructors'?{staffId:staffId||null}:{})});}}>
  {kind==='instructors'&&<Field label="الربط بفريق أودير"><select value={staffId} disabled={busy} onChange={event=>{setStaffId(event.target.value);const person=staff.find(item=>item.id===event.target.value);setName(person?.name||'');setEmail(person?.email||'');setPhone(person?.phone||'');}}><option value="">إنشاء ملف محاضر جديد</option>{staff.map(person=><option key={person.id} value={person.id}>{person.name} · {person.email||'بدون بريد'}</option>)}</select></Field>}
  <div className={styles.formGrid}><Field label="الاسم كاملًا"><input value={name} onChange={event=>setName(event.target.value)} disabled={busy||Boolean(staffId)} required minLength={2} maxLength={200}/></Field><Field label="البريد الإلكتروني"><input type="email" dir="ltr" value={email} onChange={event=>setEmail(event.target.value)} disabled={busy||Boolean(staffId)} required maxLength={254}/></Field><Field label={kind==='students'?'رقم الجوال':'رقم الجوال (اختياري)'}><input type="tel" dir="ltr" value={phone} onChange={event=>setPhone(event.target.value)} disabled={busy||Boolean(staffId)} required={kind==='students'} maxLength={30}/></Field></div>{staffId&&!email&&<p className={styles.hint}>أضف البريد إلى ملف هذا المحاضر في فريق أودير أولًا، ثم أعد فتح النموذج.</p>}<div><button className={styles.primary} disabled={busy||Boolean(staffId&&!email)}>{kind==='students'?'حفظ ملف الطالب':'حفظ المحاضر وإنشاء الدعوة'}</button></div>
 </form></section>;
}
