'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {businessDateTimeInput,businessDateTimeToInstant} from '../lib/task-timing.mjs';
import styles from './academy-commerce.module.css';
const status={planning:'قيد التجهيز',open:'التسجيل مفتوح',in_progress:'قيد التدريب',completed:'مكتمل',cancelled:'ملغى',scheduled:'مجدول'};
const Field=({label,children})=><label className={styles.field}><span>{label}</span>{children}</label>;
export default function AcademyScheduleWorkspace({slug,initialData}){
 const [data,setData]=useState(initialData),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[editing,setEditing]=useState(null);
 const active=useRef(false),requests=useRef(new Map());const run=data.selectedRun,zone=data.tenant.timezone||'UTC';
 const format=value=>value?new Intl.DateTimeFormat('ar-SA',{timeZone:zone,calendar:'gregory',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'غير محدد';
 async function fetchSnapshot(runId,offset=data.offset){
  const response=await fetch('/api/academy-schedule/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,payload:{runId,offset}})});
  const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر تحميل الجدول.');
  if(result.tenant?.slug!==slug)throw Error('تعذر التحقق من بيانات المنشأة.');setData(result);
 }
 async function load(runId,offset=data.offset){
  if(active.current)return;active.current=true;setBusy(true);setError('');setNotice('');setEditing(null);
  try{await fetchSnapshot(runId,offset);}catch(e){setError(e.message);}finally{active.current=false;setBusy(false);}
 }
 async function act(action,payload){
  if(active.current)return false;active.current=true;setBusy(true);setError('');setNotice('');
  const signature=JSON.stringify([action,payload]);if(!requests.current.has(signature))requests.current.set(signature,crypto.randomUUID());
  try{
   const response=await fetch(`/api/academy-schedule/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,commandId:requests.current.get(signature),payload})});
   const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر تنفيذ الإجراء.');
   requests.current.delete(signature);setNotice('حُفظت العملية.');setEditing(null);await fetchSnapshot(payload.runId);return true;
  }catch(e){setError(e.message);return false;}finally{active.current=false;setBusy(false);}
 }
 const sessionPayload=session=>({runId:run.id,expectedRunVersion:run.version,sessionId:session.id,expectedSessionVersion:session.version});
 const locked=run&&!['planning','open','in_progress'].includes(run.status);
 async function saveSession(values){
  try{return await act('save_session',{runId:run.id,expectedRunVersion:run.version,...(editing?sessionPayload(editing):{}),...values,
   startsAt:businessDateTimeToInstant(values.startsAt,zone,{originalInstant:editing?.startsAt}),
   endsAt:businessDateTimeToInstant(values.endsAt,zone,{originalInstant:editing?.endsAt})});}
  catch(e){setError(e.message);return false;}
 }
 return <div className={styles.workspace} dir="rtl"><header className={styles.heading}><div><span className={styles.eyebrow}>التدريب واللقاءات</span><h1>إدارة الدفعات واللقاءات</h1><p>كل المواعيد بتوقيت المنشأة: <b dir="ltr">{zone}</b></p></div><button className={styles.button} disabled={busy} onClick={()=>load(run?.id||null)}>تحديث الجدول</button></header>
 {error&&<p className={styles.error} role="alert">{error}</p>}{notice&&<p className={styles.notice} role="status">{notice}</p>}
 <section className={styles.panel}><Field label="اختر الدفعة"><select value={run?.id||''} disabled={busy} onChange={e=>load(e.target.value||null)}><option value="">اختر دفعة لعرض لقاءاتها</option>{data.runs.map(r=><option key={r.id} value={r.id}>{r.title} — {status[r.status]}</option>)}</select></Field><div className={styles.row}><button className={styles.button} disabled={busy||data.offset===0} onClick={()=>load(null,Math.max(0,data.offset-50))}>الدفعات السابقة</button><button className={styles.button} disabled={busy||!data.hasMore} onClick={()=>load(null,data.offset+50)}>الدفعات التالية</button></div>{!data.runs.length&&<p>أنشئ دفعة من متجر الدورات لتبدأ جدولة لقاءاتها.</p>}</section>
 {run&&<><section className={styles.panel}><div className={styles.row}><h2>{run.title}</h2><span className={styles.badge}>{status[run.status]}</span></div><p>{format(run.startsAt)} ← {format(run.endsAt)}</p><p className={styles.muted}>{run.sessionCount} لقاءات · {run.pendingSessions} تنتظر الإكمال · {run.missingAttendance} سجلات حضور ناقصة</p><Link className={styles.button} href={`/academy/${encodeURIComponent(slug)}/lms/calendar`}>تسجيل الحضور وإسناد المحاضر</Link>
 {!locked&&<form className={styles.form} onSubmit={e=>{e.preventDefault();const action=e.nativeEvent.submitter?.value;if(action)void act(action,{runId:run.id,expectedRunVersion:run.version,reviewed:true});}}><label className={styles.check}><input type="checkbox" required disabled={busy}/>راجعت اللقاءات وسجلات الحضور قبل تغيير حالة الدفعة.</label><div className={styles.row}>{run.status==='open'&&<button className={styles.button} value="start_run" disabled={busy}>بدء التدريب</button>}{['open','in_progress'].includes(run.status)&&<button className={styles.button} value="complete_run" disabled={busy}>إغلاق الدفعة بعد اكتمالها</button>}</div><p className={styles.muted}>إغلاق الدفعة لا يصدر الشهادات؛ تبقى شروط التقييم والحضور والسداد مطبقة.</p></form>}</section>
 {!locked&&!run.selfPaced&&<SessionForm key={`${run.id}-${editing?.id||'new'}-${editing?.version||run.version}`} session={editing} zone={zone} busy={busy} onCancel={()=>setEditing(null)} onSave={saveSession}/>}
 <section className={styles.stack}>{data.sessions.map(s=><article className={styles.panel} key={s.id}><div className={styles.row}><h2>{s.number}. {s.title}</h2><span className={styles.badge}>{status[s.status]}</span></div><p>{format(s.startsAt)} ← {format(s.endsAt)}</p>{s.instructorName&&<p>المحاضر: {s.instructorName}</p>}{s.location&&<p>{s.location}</p>}{s.meetingUrl&&/^https:\/\//.test(s.meetingUrl)&&<a className={styles.button} href={s.meetingUrl} target="_blank" rel="noreferrer">رابط اللقاء</a>}
 {!locked&&s.status==='scheduled'&&<div className={styles.stack}><button className={styles.button} disabled={busy||s.providerManaged} onClick={()=>setEditing(s)}>تعديل اللقاء</button><form className={styles.form} onSubmit={e=>{e.preventDefault();void act('complete_session',{...sessionPayload(s),reviewed:true});}}><label className={styles.check}><input type="checkbox" required disabled={busy}/>انتهى اللقاء وراجعت سجل حضور المتدربين.</label><button className={styles.primary} disabled={busy}>تأكيد اكتمال اللقاء</button></form>{!s.hasAttendance&&<details><summary>إلغاء اللقاء</summary><form className={styles.form} onSubmit={e=>{e.preventDefault();void act('cancel_session',{...sessionPayload(s),reason:new FormData(e.currentTarget).get('reason')});}}><Field label="سبب الإلغاء"><input name="reason" minLength={5} maxLength={500} required/></Field><button className={styles.button} disabled={busy}>إلغاء مع حفظ السجل</button></form></details>}{s.hasAttendance&&<p className={styles.muted}>توقيت اللقاء محفوظ لوجود سجل حضور.</p>}</div>}</article>)}{!data.sessions.length&&<p className={styles.notice}>{run.selfPaced?'التعلّم الذاتي لا يحتاج لقاءات مجدولة.':'لا توجد لقاءات بعد. أضف اللقاء الأول.'}</p>}</section></>}
 </div>;
}
function SessionForm({session,zone,busy,onSave,onCancel}){
 const [mode,setMode]=useState(session?.deliveryMode||'online');
 return <section className={styles.panel}><h2>{session?'تعديل اللقاء':'إضافة لقاء'}</h2><form className={styles.form} onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;const saved=await onSave(Object.fromEntries(new FormData(form)));if(saved&&!session)form.reset();}}><div className={styles.grid}><Field label="عنوان اللقاء"><input name="title" defaultValue={session?.title||''} minLength={2} maxLength={200} required/></Field><Field label="طريقة التقديم"><select name="deliveryMode" value={mode} onChange={e=>setMode(e.target.value)}><option value="online">عن بعد</option><option value="onsite">حضوري</option><option value="hybrid">مدمج</option></select></Field><Field label={`البداية (${zone})`}><input name="startsAt" type="datetime-local" defaultValue={businessDateTimeInput(session?.startsAt,zone)} required readOnly={session?.hasAttendance}/></Field><Field label={`النهاية (${zone})`}><input name="endsAt" type="datetime-local" defaultValue={businessDateTimeInput(session?.endsAt,zone)} required readOnly={session?.hasAttendance}/></Field><Field label="اسم المحاضر الظاهر"><input name="instructorName" defaultValue={session?.instructorName||''} maxLength={200}/></Field>{mode!=='onsite'&&<Field label="رابط اللقاء الآمن"><input name="meetingUrl" type="url" pattern="https://.*" defaultValue={session?.meetingUrl||''} maxLength={2000} dir="ltr" required/></Field>}{mode!=='online'&&<Field label="مكان الحضور"><input name="location" defaultValue={session?.location||''} minLength={2} maxLength={500} required/></Field>}</div><p className={styles.muted}>إدخال اسم المحاضر لا يمنحه صلاحية الدخول؛ عيّن حسابه من شاشة المحاضرين. رابط اللقاء يُضاف من حساب الاجتماعات الخاص بالمركز.</p><div className={styles.row}><button className={styles.primary} disabled={busy}>حفظ اللقاء</button>{session&&<button type="button" className={styles.button} disabled={busy} onClick={onCancel}>إلغاء التعديل</button>}</div></form></section>;
}
