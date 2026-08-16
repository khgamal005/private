'use client';

import {useEffect} from 'react';
import styles from './tenant-error-state.module.css';

export default function TenantErrorState({error,reset}){
  useEffect(()=>{
    console.error('[tenant-render-failure]',{
      digest:error?.digest||null,
      name:error?.name||'Error'
    });
  },[error]);

  return <main className={styles.page} dir="rtl">
    <section className={styles.card} role="alert">
      <span className={styles.icon} aria-hidden="true">!</span>
      <p className={styles.eyebrow}>تعذّر تحميل جزء من لوحة المنشأة</p>
      <h1>بياناتك محفوظة، ويمكنك المحاولة مرة أخرى</h1>
      <p className={styles.copy}>
        حدث تأخير مؤقت أثناء جلب البيانات. أعد المحاولة، وإن انتهت الجلسة سجّل الدخول من جديد.
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={()=>reset()}>إعادة المحاولة</button>
        <a href="/login">تسجيل الدخول</a>
      </div>
      {error?.digest&&<small>المرجع الفني: <bdi>{error.digest}</bdi></small>}
    </section>
  </main>;
}
