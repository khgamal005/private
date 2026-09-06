'use client';
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from 'react';
import Link from 'next/link';
import styles from './payment-method-picker.module.css';
const TERMINAL=new Set(['paid','cancelled','refunded','review_required']);
export default function TamaraReturnStatus({slug,attemptId}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let disposed=false,timer,count=0;
  const controller=new AbortController();
  async function check(){
   try{
    const response=await fetch(`/api/payments/tamara/status?slug=${encodeURIComponent(slug)}&attempt=${encodeURIComponent(attemptId)}`,{cache:'no-store',signal:controller.signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تحديث حالة الدفع');
    if(disposed)return;
    setData(result);setError('');
    if(!TERMINAL.has(result.status)&&++count<24)timer=setTimeout(check,5000);
   }catch(err){if(!disposed)setError(err.message||'تعذر تحديث الحالة');}
  }
  check();return()=>{disposed=true;clearTimeout(timer);controller.abort();};
 },[slug,attemptId,refresh]);
 const paid=data?.status==='paid'&&data?.paymentStatus==='paid'&&data?.activationState==='active';
 const title=paid?'تم الدفع وتفعيل الإضافة':data?.status==='cancelled'?'لم تكتمل عملية الدفع':data?.status==='refunded'?'تم استرداد المبلغ':data?.status==='review_required'?'العملية قيد المراجعة':'نتحقق من حالة الدفع';
 return <section className={styles.result} dir="rtl">
  <img src="/payment-brands/tamara-ar.svg" alt="تمارا" width="112" height="48"/>
  <div role="status" aria-live="polite"><span className={paid?styles.success:styles.pending} aria-hidden="true">{paid?'✓':'…'}</span><h1>{title}</h1>
   <p>{paid?'أصبحت الإضافة جاهزة للاستخدام في منشأتك.':'سنحدّث هذا الطلب عند وصول التأكيد. لا تحتاج إلى بدء دفعة جديدة.'}</p></div>
  {data?.orderNumber&&<p>رقم الطلب <bdi>{data.orderNumber}</bdi></p>}
  {error&&<p role="alert">{error}</p>}
  {data?.checkoutUrl&&<a className={styles.continue} href={data.checkoutUrl}>استكمال الدفع لدى تمارا</a>}
  {!paid&&<button type="button" onClick={()=>setRefresh(x=>x+1)}>تحديث الحالة</button>}
  <Link href={`/tenant/${encodeURIComponent(slug)}/addons-store`}>العودة إلى الإضافات</Link>
 </section>;
}
