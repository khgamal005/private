'use client';
import {useEffect,useRef,useState} from 'react';
import styles from './campaign-decision.module.css';
export default function CampaignRecommendations(props){
 const key=JSON.stringify([props.slug,props.platform,props.filters]);
 return <Recommendations key={key} {...props}/>;
}
function Recommendations({slug,platform,filters,available}){
 const [busy,setBusy]=useState(false),[result,setResult]=useState(null),[error,setError]=useState('');
 const active=useRef(null);
 useEffect(()=>()=>active.current?.abort(),[]);
 async function analyze(){
  if(busy||!available)return;const controller=new AbortController();active.current=controller;setBusy(true);setError('');
  try{
   const response=await fetch('/api/odeiry/chat',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({slug,clientRequestId:crypto.randomUUID(),assistantMode:'manager_v1',context:{module:'reports',pathClass:'workspace.reports'},message:'حلل تقرير الحملات المحدد. ابدأ بأهم إجراءين للمدير مع الدليل وحدود البيانات، ثم اقترح ما نراجعه لاحقًا. لا تنفذ أي تغييرات.',reportContext:{platform,from:filters.dateFrom,to:filters.dateTo,asOf:filters.asOf,mode:filters.mode||'cohort',staff:filters.staff||'',course:filters.course||'',q:filters.search||'',metaQ:filters.metaSearch||'',status:filters.status||'all',campaign:filters.campaign||'',group:filters.group||''}})});
   const body=await response.json();if(!response.ok||body.success!==true)throw new Error(body.error||'تعذر تجهيز التوصيات الآن.');if(!controller.signal.aborted)setResult(body.data);
  }catch(e){if(e.name!=='AbortError')setError(e.message);}finally{if(!controller.signal.aborted)setBusy(false);}
 }
 return <section className={styles.panel} aria-label="توصيات التقرير" aria-busy={busy}><div className={styles.heading}><div><small>مساعد القرار</small><h2>ماذا نراجع أولًا؟</h2></div>{available?<button type="button" disabled={busy} onClick={analyze}>{busy?'جارٍ تحليل التقرير…':result?'تحديث التوصيات':'تحليل التقرير بالذكاء الاصطناعي'}</button>:null}</div>
 <p className={styles.hint}>{available?'أوديري يقرأ مؤشرات هذه الفترة بصلاحياتك. تُحتسب المحاولة ضمن رصيد أوديري؛ التوصيات للمراجعة ولا تغيّر الحملات.':'تظهر توصيات AI عند تفعيل أوديري الإداري لحساب عضو المنشأة المخوّل. تبقى مؤشرات التقرير متاحة حسب صلاحياتك.'}</p>
 {error?<p role="alert">{error}</p>:null}{result?<div className={styles.answer} role="status"><p>{result.reply}</p>{result.steps?.length?<ol>{result.steps.map((s,i)=><li key={i}>{typeof s==='string'?s:s.title||s.description||''}</li>)}</ol>:null}<p className={styles.hint}>المصدر: {result.sources?.map(s=>s.title).join('، ')||'لم يتوفر دليل كافٍ من التقرير'}. راجع التوصية قبل اتخاذ قرار.</p></div>:null}</section>;
}
