import Link from 'next/link';
import {getAcademyAccess} from '../../../lib/academy-server';
import {academyBasePath,academyTrainingHref,academyTrainingViews} from '../../../lib/academy-navigation.mjs';
import styles from '../../../components/academy-shell.module.css';

export const dynamic='force-dynamic';

export default async function AcademyOverviewPage({params}){
  const {slug}=await params;
  const access=await getAcademyAccess(slug);
  const base=academyBasePath(slug);
  const trainingViews=academyTrainingViews(access);
  const website=access.components?.website===true&&access.permissions?.manageWebsite===true;
  const store=access.components?.store===true&&(access.permissions?.manageStore===true||access.permissions?.manageAdmissions===true||access.permissions?.verifyPayments===true);
  return <div className={styles.overview}>
    <section className={styles.intro}><small>{access.tenant.name}</small><h2>موقعك وتجربة التعلّم، في مساحة واحدة</h2><p>أدر صفحات المنشأة ومحتوى الدورات، وتابع المتدربين والمحاضرين والنتائج من لوحة المنصة التدريبية.</p></section>
    <div className={styles.cards}>
      {website&&<article className={styles.card}><span className={styles.cardLabel}>الموقع الإلكتروني</span><h3>واجهة منشأتك</h3><p>جهّز الصفحات والمقالات والقوائم والوسائط، وصمّم الموقع وانشر التحديثات.</p><Link href={`${base}/website`} className={styles.primaryButton}>إدارة الموقع</Link></article>}
      {store&&<article className={styles.card}><span className={styles.cardLabel}>متجر الدورات</span><h3>الدورات والطلبات</h3><p>جهّز عروض الدورات، وتابع الطلبات والقبول وتأكيد السداد لبدء رحلة المتدرب.</p><Link href={`${base}/store`} className={styles.primaryButton}>إدارة المتجر والطلبات</Link></article>}
      {trainingViews.length>0&&<article className={styles.card}><span className={styles.cardLabel}>منصة التدريب التفاعلي</span><h3>رحلة التعلّم</h3><p>أدر الدورات والتسجيلات والحضور والتقييمات، وتابع خطوات إكمال التدريب وإصدار الشهادات حسب صلاحياتك.</p><Link href={academyTrainingHref(slug,trainingViews[0].key)} className={styles.primaryButton}>إدارة التدريب</Link></article>}
      {access.odeirAccess===true&&<article className={styles.card}><span className={styles.cardLabel}>تشغيل المنشأة</span><h3>لوحة أودير</h3><p>تابع المبيعات والعملاء والحسابات وفريق العمل من لوحة تشغيل المنشأة المرتبطة.</p><Link href={`/tenant/${encodeURIComponent(slug)}`} className={styles.secondaryButton}>فتح أودير</Link></article>}
    </div>
    {!website&&!store&&!trainingViews.length&&<p className={styles.message}>حسابك مرتبط بالمنصة. تواصل مع مدير المنصة لتحديد صلاحيات إدارة الموقع أو التدريب.</p>}
    {access.components?.lms===true&&<div className={styles.links}><Link href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy`}>رابط دخول المتدربين</Link><Link href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy&role=instructor`}>رابط دخول المحاضرين</Link></div>}
  </div>;
}
