'use client';

import {useMemo,useRef,useState} from 'react';
import {requestWooBeneficiaries} from '../lib/woocommerce-beneficiaries.mjs';
import styles from './woocommerce-beneficiaries.module.css';

const money=value=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR'}).format(Number(value||0)/100);
export default function WooCommerceBeneficiaryAdmissions({slug,item,courseRuns,canManage,busy,onBusyChange,onSaved}){
  const seats=item.beneficiaries||[];
  const [choices,setChoices]=useState(()=>Object.fromEntries(seats.map(seat=>[seat.id,seat.courseRunId||''])));
  const [error,setError]=useState(''),[saving,setSaving]=useState(false);
  const command=useRef(null);
  const runs=useMemo(()=>courseRuns.filter(run=>run.courseId===item.courseId&&run.registrationOpen!==false),[courseRuns,item.courseId]);
  const selected=seats.filter(seat=>!seat.enrollmentId&&choices[seat.id]);
  const remaining=seats.filter(seat=>!seat.enrollmentId).length;
  const locked=!canManage||busy||saving||item.paymentStatus!=='verified'||item.paymentOnHold||['cancelled','rejected'].includes(item.originalStatus||item.status);
  function choose(id,value){setChoices(current=>({...current,[id]:value}));command.current=null;setError('');}
  async function save(){
    const body={p_tenant_slug:slug,p_handoff_id:item.id,p_expected_revision:item.beneficiaryRevision,
      p_seats:selected.map(seat=>({id:seat.id,courseRunId:choices[seat.id]}))};
    const signature=JSON.stringify(body);
    if(command.current?.signature!==signature)command.current={signature,id:crypto.randomUUID()};
    setSaving(true);onBusyChange(true);setError('');
    try{const result=await requestWooBeneficiaries('enroll',{...body,p_command_id:command.current.id});onSaved(result);}
    catch(err){setError(err.message);}
    finally{setSaving(false);onBusyChange(false);}
  }
  return <section className={styles.section} aria-label="تسجيل المستفيدين">
    <header className={styles.heading}><div><h3>تسجيل المستفيدين</h3>
      <small>تم تسجيل {seats.length-remaining} من {seats.length} · بلاغ دفع واحد دون تكرار المبلغ.</small></div></header>
    {remaining>1&&canManage&&<label className={styles.sharedRun}>دفعة واحدة لجميع غير المسجلين<select defaultValue="" disabled={locked} onChange={event=>{
      const value=event.target.value;if(!value)return;
      setChoices(current=>({...current,...Object.fromEntries(seats.filter(seat=>!seat.enrollmentId).map(seat=>[seat.id,value]))}));command.current=null;setError('');
    }}><option value="">اختر لتطبيق الدفعة على الجميع</option>{runs.map(run=><option key={run.id} value={run.id}>{run.title}</option>)}</select></label>}
    <div className={styles.people}>{seats.map(seat=><article className={styles.person} key={seat.id}>
      <div className={styles.lineHeading}><b>{seat.name}</b><span>المقعد {seat.seatNumber}</span></div>
      <small dir="ltr">{seat.phone}</small><small>حصة المقعد: {money(seat.allocatedMinor)}</small>
      {seat.enrollmentId?<p className={styles.success}>مسجل بالفعل · {seat.courseRunName||'دفعة محددة'}<small>رقم المتدرب: {seat.studentNumber}</small></p>
        :<label>دفعة {seat.name}<select disabled={locked} value={choices[seat.id]||''} onChange={event=>choose(seat.id,event.target.value)}>
          <option value="">اختر الدفعة</option>{runs.map(run=><option key={run.id} value={run.id}>
            {run.title} · {run.availableSeats??(run.capacity==null?'∞':Math.max(0,run.capacity-(run.enrolledCount||0)))} مقعد متاح
          </option>)}
        </select></label>}
    </article>)}</div>
    {remaining>0&&canManage&&<div className={styles.saveRow}><small>يمكن تسجيل الجميع معًا أو استكمال بعض المقاعد لاحقًا.</small>
      <button type="button" className={styles.primary} disabled={locked||selected.length===0} onClick={save}>
        {saving?'جارٍ تسجيل المستفيدين…':`تسجيل المستفيدين المحددين (${selected.length})`}
      </button></div>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
  </section>;
}
