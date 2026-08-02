'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import styles from './sales-team-assignments.module.css';

export default function SalesTeamAssignments({slug,initialData,canManage}){
  const router=useRouter();
  const supervisors=initialData?.supervisors||[];
  const members=initialData?.members||[];
  const [assignments,setAssignments]=useState(()=>Object.fromEntries(
    members.map(member=>[member.id,member.supervisorStaffId||''])
  ));
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const assignedCount=useMemo(()=>Object.values(assignments).filter(Boolean).length,[assignments]);

  async function assign(memberId,supervisorId){
    const previous=assignments[memberId]||'';
    setAssignments(current=>({...current,[memberId]:supervisorId}));
    setBusy(memberId);setMessage('');setError('');
    try{
      const response=await fetch('/api/tenant/sales-teams',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          tenantSlug:slug,
          staffId:memberId,
          supervisorStaffId:supervisorId||null
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر حفظ إسناد الفريق');
      setMessage('تم تحديث فريق مسؤول المبيعات');
      router.refresh();
    }catch(err){
      setAssignments(current=>({...current,[memberId]:previous}));
      setError(err.message);
    }finally{setBusy('')}
  }

  if(!supervisors.length&&!members.length)return null;

  return <section className={styles.panel} aria-label="توزيع فرق المبيعات">
    <header className={styles.head}>
      <div>
        <span>SALES TEAM STRUCTURE</span>
        <h2>إسناد مسؤولي المبيعات إلى المشرفين</h2>
        <p>حدد المشرف المباشر لكل مسؤول مبيعات. سيُستخدم هذا الإسناد في ترتيب المبيعات ولوحات الأداء والتقارير.</p>
      </div>
      <div className={styles.summary}>
        <div><b>{supervisors.length}</b><span>مشرفون</span></div>
        <div><b>{assignedCount}</b><span>مسندون</span></div>
        <div><b>{members.length-assignedCount}</b><span>دون فريق</span></div>
      </div>
    </header>

    {message&&<div className={styles.success}>{message}</div>}
    {error&&<div className={styles.error}>{error}</div>}

    <div className={styles.supervisors}>
      {supervisors.map(supervisor=>{
        const count=Object.values(assignments).filter(id=>id===supervisor.id).length;
        return <article key={supervisor.id}>
          <i>{supervisor.name?.[0]||'م'}</i>
          <div><b>{supervisor.name}</b><span>{supervisor.jobTitle||'مشرف مبيعات'}</span></div>
          <strong>{count} أعضاء</strong>
        </article>;
      })}
    </div>

    <div className={styles.rows}>
      {members.map(member=><div className={styles.row} key={member.id}>
        <div className={styles.person}>
          <i>{member.name?.[0]||'م'}</i>
          <div><b>{member.name}</b><span>{member.jobTitle||'مسؤول مبيعات'}</span></div>
        </div>
        <label>
          <span>المشرف المباشر</span>
          <select
            value={assignments[member.id]||''}
            disabled={!canManage||busy===member.id}
            onChange={event=>assign(member.id,event.target.value)}
          >
            <option value="">غير مسند إلى فريق</option>
            {supervisors.map(supervisor=><option value={supervisor.id} key={supervisor.id}>{supervisor.name}</option>)}
          </select>
        </label>
        <small className={assignments[member.id]?styles.assigned:styles.unassigned}>
          {busy===member.id?'جارٍ الحفظ…':assignments[member.id]?'ضمن فريق مبيعات':'يحتاج إسنادًا'}
        </small>
      </div>)}
    </div>
  </section>;
}
