'use client';

import {useEffect,useState} from 'react';
import {formatCustomerPhone} from '../lib/customer-phone.mjs';
import {attendanceLabel,availableAdditionalPhoneSlots,MAX_INTERESTS,requestFollowupDetails} from '../lib/sales-followup-details.mjs';
import styles from './sales-followup-details.module.css';

export const emptyInterest=()=>({key:crypto.randomUUID(),courseId:'',courseRunId:'',attendanceSessionId:''});

export function useFollowupDetails(slug,contactId){
  const [details,setDetails]=useState(null);
  const [loadError,setLoadError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    requestFollowupDetails('sales-followup-context',{p_tenant_slug:slug,p_contact_id:contactId},controller.signal)
      .then(data=>{
        if(controller.signal.aborted)return;
        const rows=(data.courseInterests||[]).map(row=>({...row,key:crypto.randomUUID()}));
        setDetails({...data,contextKey:`${slug}:${contactId}`,rows:rows.length?rows:[emptyInterest()],
          phones:(data.additionalPhones||[]).map(value=>({key:crypto.randomUUID(),value:formatCustomerPhone(value)}))});
        setLoadError('');
      })
      .catch(error=>{if(error.name!=='AbortError')setLoadError(error.message);});
    return ()=>controller.abort();
  },[slug,contactId,attempt]);
  return {details:details?.contextKey===`${slug}:${contactId}`?details:null,setDetails,loadError,retry:()=>setAttempt(value=>value+1)};
}

function InterestRow({row,index,rows,courses,slug,contactId,timezone,disabled,onChange,onRemove}){
  const [options,setOptions]=useState(null);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!row.courseId)return;
    const controller=new AbortController();
    requestFollowupDetails('sales-followup-options',{
      p_tenant_slug:slug,p_contact_id:contactId,p_course_id:row.courseId
    },controller.signal).then(data=>{setOptions(data);setError('');})
      .catch(err=>{if(err.name!=='AbortError')setError(err.message);});
    return ()=>controller.abort();
  },[row.courseId,slug,contactId,attempt]);
  const loaded=options?.courseId===row.courseId;
  const runs=loaded?options.runs:[];
  const run=runs.find(item=>item.id===row.courseRunId);
  const sessions=run?.sessions||[];
  const selectedCourses=new Set(rows.filter(item=>item.key!==row.key).map(item=>item.courseId));
  const selectedSession=sessions.find(item=>item.id===row.attendanceSessionId);
  return <fieldset className={styles.courseCard} disabled={disabled}>
    <legend>الدورة {index+1}</legend>
    <div className={styles.courseHead}>
      <label className="mt-field">الدورة المهتم بها
        <select value={row.courseId} onChange={event=>{
          setOptions(null);setError('');
          onChange({...row,courseId:event.target.value,courseRunId:'',attendanceSessionId:'',runTitle:'',sessionTitle:'',attendanceAt:null});
        }}>
          <option value="">اختر الدورة</option>
          {row.courseId&&!courses.some(course=>course.id===row.courseId)&&<option value={row.courseId}>{row.courseName||'الدورة المحفوظة'}</option>}
          {courses.map(course=><option key={course.id} value={course.id} disabled={selectedCourses.has(course.id)}>{course.nameAr}</option>)}
        </select>
      </label>
      <button type="button" className={styles.remove} onClick={onRemove} aria-label={`إزالة الدورة ${index+1}`} title="إزالة الدورة">×</button>
    </div>
    <div className={styles.schedule}>
      <label className="mt-field">الدفعة
        <select value={row.courseRunId||''} disabled={!row.courseId||!loaded} onChange={event=>onChange({...row,courseRunId:event.target.value,attendanceSessionId:'',sessionTitle:'',attendanceAt:null})}>
          <option value="">{!row.courseId?'اختر الدورة أولًا':!loaded?'جارٍ تحميل الدفعات…':'لم تحدد الدفعة بعد'}</option>
          {row.courseRunId&&!run&&<option value={row.courseRunId}>{row.runTitle||'الدفعة المحفوظة'}{loaded?' · غير متاحة حاليًا':''}</option>}
          {runs.map(item=><option key={item.id} value={item.id}>{item.title} · {attendanceLabel(item.startsAt,timezone)}</option>)}
        </select>
      </label>
      <label className="mt-field">موعد حضور الدورة
        <select value={row.attendanceSessionId||''} disabled={!run} onChange={event=>onChange({...row,attendanceSessionId:event.target.value})}>
          <option value="">{run?`بداية الدفعة · ${attendanceLabel(run.startsAt,timezone)}`:'اختر الدفعة أولًا'}</option>
          {row.attendanceSessionId&&!selectedSession&&<option value={row.attendanceSessionId}>{row.sessionTitle||'الموعد المحفوظ'}{loaded?' · غير متاح حاليًا':''}</option>}
          {sessions.map(session=><option key={session.id} value={session.id}>{attendanceLabel(session.startsAt,timezone)} · {session.title}</option>)}
        </select>
      </label>
    </div>
    {run&&<p className={styles.hint}>الحضور: {attendanceLabel(selectedSession?.startsAt||run.startsAt,timezone)}</p>}
    {row.courseId&&loaded&&!runs.length&&<p className={styles.hint}>لا توجد دفعات متاحة لهذه الدورة حاليًا. يمكنك حفظ الاهتمام وتحديد الدفعة لاحقًا.</p>}
    {error&&<p className={styles.error} role="alert">{error} <button type="button" onClick={()=>setAttempt(value=>value+1)}>إعادة المحاولة</button></p>}
  </fieldset>;
}

export default function SalesFollowupDetails({slug,contactId,courses,details,setDetails,loadError,retry,busy}){
  if(!details)return <div className={`wide ${styles.loading}`} role={loadError?'alert':'status'}>
    {loadError?<>{loadError} <button type="button" className="mt-button" onClick={retry}>إعادة المحاولة</button></>:'جارٍ تحميل دورات العميل وأرقامه…'}
  </div>;
  const updateRow=(key,next)=>setDetails(current=>({...current,rows:current.rows.map(row=>row.key===key?next:row)}));
  return <>
    <section className={`wide ${styles.section}`} aria-label="أرقام العميل">
      <div className={styles.sectionHead}>
        <div><b>أرقام العميل</b><small>جوال أساسي وأربعة أرقام إضافية بحد أقصى؛ واتساب المختلف ضمن الأرقام الإضافية.</small></div>
        <button type="button" className={styles.add} disabled={busy||details.phones.length>=availableAdditionalPhoneSlots(details.primaryPhone,details.whatsapp)}
          onClick={()=>setDetails(current=>({...current,phones:[...current.phones,{key:crypto.randomUUID(),value:''}]}))}>
          <span aria-hidden="true">+</span> إضافة رقم
        </button>
      </div>
      <div className={styles.primaryPhone}><span>الرقم الأساسي</span><b dir="ltr">{formatCustomerPhone(details.primaryPhone)||'غير مسجل'}</b></div>
      {details.phones.map((phone,index)=><div className={styles.phoneRow} key={phone.key}>
        <label className="mt-field">رقم إضافي {index+1}<input type="tel" inputMode="tel" dir="ltr" maxLength={40} autoComplete="off"
          value={phone.value} placeholder="05xxxxxxxx" disabled={busy}
          onChange={event=>setDetails(current=>({...current,phones:current.phones.map(item=>item.key===phone.key?{...item,value:event.target.value}:item)}))}/></label>
        <button type="button" className={styles.remove} disabled={busy} aria-label={`إزالة الرقم الإضافي ${index+1}`} onClick={()=>setDetails(current=>({...current,phones:current.phones.filter(item=>item.key!==phone.key)}))}>×</button>
      </div>)}
    </section>
    <section className={`wide ${styles.section}`} aria-label="الدورات والدفعات">
      <div className={styles.sectionHead}>
        <div><b>الدورات المهتم بها</b><small>اختر لكل دورة دفعتها وموعد حضورها.</small></div>
        <button type="button" className={styles.add} disabled={busy||details.rows.length>=MAX_INTERESTS||details.rows.some(row=>!row.courseId)}
          onClick={()=>setDetails(current=>({...current,rows:[...current.rows,emptyInterest()]}))}>
          <span aria-hidden="true">+</span> إضافة دورة
        </button>
      </div>
      {details.rows.map((row,index)=><InterestRow key={row.key} row={row} index={index} rows={details.rows} courses={courses}
        slug={slug} contactId={contactId} timezone={details.timezone} disabled={busy}
        onChange={next=>updateRow(row.key,next)} onRemove={()=>setDetails(current=>({
          ...current,rows:current.rows.length===1?[emptyInterest()]:current.rows.filter(item=>item.key!==row.key)
        }))}/>)}
      <p className={styles.hint}>يمكن تحديد الدفعة والموعد لاحقًا. موعد الحضور لا يغيّر موعد متابعة العميل.</p>
    </section>
  </>;
}

export function FollowupDetailsSummary({contact,timezone}){
  const interests=contact?.courseInterests||[];
  const phones=contact?.additionalPhones||[];
  if(!interests.length&&!phones.length)return null;
  return <section className={styles.summary} aria-label="دورات العميل وأرقامه الإضافية">
    {interests.length>0&&<><b>الدورات المهتم بها</b>{interests.map(item=><div key={item.courseId}>
      <strong>{item.courseName}</strong>
      <small>{item.runTitle||'الدفعة لم تحدد'}{item.attendanceAt?` · ${attendanceLabel(item.attendanceAt,timezone)}`:''}</small>
    </div>)}</>}
    {phones.length>0&&<><b>أرقام إضافية</b><div className={styles.summaryPhones}>{phones.map(phone=><a key={phone} href={`tel:+${phone}`} dir="ltr">{formatCustomerPhone(phone)}</a>)}</div></>}
  </section>;
}
