'use client';

import {useRef,useState} from 'react';
import type {TrainingJourneySnapshot} from '../lib/training-journey-contract';
import styles from './training-journey.module.css';

export default function AcademyLearnerPaths({slug,initialData}:{slug:string;initialData:NonNullable<TrainingJourneySnapshot['learningPaths']>}){
  const [fetched,setFetched]=useState<{base:typeof initialData;data:typeof initialData}|null>(null);
  const data=fetched?.base===initialData?fetched.data:initialData;
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false);
  const pageSize=data.pageSize||20;
  async function page(offset:number){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{
      const response=await fetch('/api/academy-authoring/learner_paths',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,payload:{offset}})});
      const result=await response.json();
      if(!response.ok||!Array.isArray(result.paths))throw new Error('تعذر تحميل المسارات. حاول مرة أخرى.');
      setFetched({base:initialData,data:result});
    }catch{setError('تعذر تحميل المسارات. حاول مرة أخرى.');}
    finally{setBusy(false);inFlight.current=false;}
  }
  if(!data.paths?.length&&!data.offset)return null;
  return <section className={styles.panel} aria-label="مساراتي التدريبية" aria-busy={busy}><h2>مساراتي التدريبية</h2><p className={styles.secondaryText}>ترتيب مقترح لدوراتك. يتاح محتوى كل دورة بعد اكتمال تسجيلك فيها.</p>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.stack}>{data.paths.map(path=><article key={path.id} className={styles.card}><h3>{path.title}</h3>{path.description&&<p>{path.description}</p>}<ol>{path.courses.map(course=><li key={course.id}><div className={styles.row}><span>{course.title}</span><span className={styles.badge}>{!course.enrolled?'تحتاج إلى التسجيل':course.completed?'اكتمل المحتوى':`التقدم ${Math.round(course.progressPercent||0)}٪`}</span></div></li>)}</ol></article>)}</div>
    {(data.hasMore||data.offset>0)&&<nav className={styles.pagination} aria-label="صفحات المسارات"><button type="button" className={styles.button} disabled={busy||data.offset===0} onClick={()=>void page(Math.max(0,data.offset-pageSize))}>مسارات سابقة</button><button type="button" className={styles.button} disabled={busy||!data.hasMore} onClick={()=>void page(data.offset+pageSize)}>مسارات إضافية</button></nav>}
  </section>;
}
