'use client';

import styles from './tenant-error-state.module.css';
import {
  reloadDocument,
  useNavigationRecovery
} from './use-navigation-recovery';

export default function TenantErrorState({error,reset}){
  useNavigationRecovery(error,{
    logLabel:'tenant-render-failure'
  });

  return <main className={styles.page} dir="rtl">
    <section className={styles.card} role="alert">
      <span className={styles.icon} aria-hidden="true">!</span>
      <p className={styles.eyebrow}>تعذّر تحميل جزء من لوحة المنشأة</p>
      <h1>يمكنك استعادة الصفحة دون تكرار العملية السابقة</h1>
      <p className={styles.copy}>
        حدث تأخير مؤقت أثناء جلب البيانات. لن نعيد تنفيذ آخر عملية تلقائيًا، وإن انتهت الجلسة سجّل الدخول من جديد.
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={reloadDocument}>إعادة تحميل كاملة</button>
        <button type="button" onClick={()=>reset()}>إعادة المحاولة</button>
        <a href="/login">تسجيل الدخول</a>
      </div>
      {error?.digest&&<small>المرجع الفني: <bdi>{error.digest}</bdi></small>}
    </section>
  </main>;
}
