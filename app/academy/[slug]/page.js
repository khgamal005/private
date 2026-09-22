import Link from 'next/link';
import {getAcademyAccess} from '../../../lib/academy-server';
import {academyBasePath,academyTrainingHref,academyTrainingViews} from '../../../lib/academy-navigation.mjs';
import AcademyIcon from '../../../components/academy-icon';
import styles from '../../../components/academy-shell.module.css';

export const dynamic='force-dynamic';

export default async function AcademyOverviewPage({params}){
  const {slug}=await params;
  const access=await getAcademyAccess(slug);
  const base=academyBasePath(slug);
  const trainingViews=academyTrainingViews(access);
  const website=access.components?.website===true&&access.permissions?.manageWebsite===true;
  const store=access.components?.store===true&&(access.permissions?.manageStore===true||access.permissions?.manageAdmissions===true||access.permissions?.verifyPayments===true);
  const trainingHref=trainingViews.length?academyTrainingHref(slug,trainingViews[0].key):null;
  const primary=trainingHref?{href:trainingHref,label:'فتح إدارة التدريب'}:website?{href:`${base}/website`,label:'فتح إدارة الموقع'}:store?{href:`${base}/store`,label:'فتح إدارة المتجر'}:null;
  return <div className={styles.overview}>
    <section className={styles.intro}>
      <div className={styles.introCopy}><small>لوحة {access.tenant.name}</small><h2>من موقعك إلى الشهادة، رحلة واحدة يمكنك إدارتها.</h2><p>رتّب حضور منشأتك الرقمي، بيع الدورات، ثم تابع القبول والتعلّم والنتائج من لوحة واضحة مبنية على صلاحيات حسابك.</p><div className={styles.introActions}>{primary&&<Link href={primary.href} className={styles.primaryButton}>{primary.label}<AcademyIcon name="arrow" size={16}/></Link>}{website&&<Link href={`/site/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer" className={styles.secondaryButton}>معاينة الموقع <AcademyIcon name="external" size={15}/></Link>}</div></div>
      <div className={styles.introMap}><span>رحلة العميل في منصتك</span><ol><li><b>01</b> يزور الموقع</li><li><b>02</b> يختار الدورة</li><li><b>03</b> يُقبل ويبدأ</li><li><b>04</b> يتعلم ويكمل</li></ol></div>
    </section>

    <div className={styles.sectionHead}><div><h2>ماذا تريد أن تدير اليوم؟</h2><p>كل مساحة تجمع الإجراءات والبيانات المرتبطة بها.</p></div></div>
    <div className={styles.cards}>
      {website&&<article className={styles.card}><span className={styles.cardIcon}><AcademyIcon name="website"/></span><h3>الموقع الإلكتروني</h3><p>حرّر الصفحات والمقالات والقوائم، راجع المسودة، ثم انشر الموقع للزوار.</p><Link href={`${base}/website`} className={styles.cardLink}>إدارة الموقع <AcademyIcon name="arrow" size={15}/></Link></article>}
      {store&&<article className={styles.card}><span className={styles.cardIcon}><AcademyIcon name="store"/></span><h3>المتجر والطلبات</h3><p>جهّز عروض الدورات وتابع الطلبات والقبول وتأكيد السداد في سياق واحد.</p><Link href={`${base}/store`} className={styles.cardLink}>إدارة المتجر <AcademyIcon name="arrow" size={15}/></Link></article>}
      {trainingHref&&<article className={styles.card}><span className={styles.cardIcon}><AcademyIcon name="courses"/></span><h3>التدريب والتعلّم</h3><p>أدر المحتوى والتسجيلات والحضور والتقييمات والشهادات حسب صلاحيتك.</p><Link href={trainingHref} className={styles.cardLink}>إدارة التدريب <AcademyIcon name="arrow" size={15}/></Link></article>}
      {access.odeirAccess===true&&<article className={styles.card}><span className={styles.cardIcon}><AcademyIcon name="chart"/></span><h3>تشغيل المنشأة في أودير</h3><p>انتقل إلى المبيعات والعملاء والحسابات وفريق العمل المرتبط بهذه المنشأة.</p><Link href={`/tenant/${encodeURIComponent(slug)}`} className={styles.cardLink}>فتح أودير <AcademyIcon name="arrow" size={15}/></Link></article>}
    </div>

    {!website&&!store&&!trainingViews.length&&<p className={styles.message}>حسابك مرتبط بالمنصة. تواصل مع مدير المنصة لتحديد صلاحيات إدارة الموقع أو التدريب.</p>}
    {(website||store||trainingHref)&&<div className={styles.lowerGrid}>
      <section className={styles.journey}><header><h2>مسار تشغيل المنصة</h2><p>ابدأ من اليمين واتبع انتقال المتدرب بين مراحل الخدمة.</p></header><ol className={styles.journeyList}><li><strong>تجهيز الواجهة</strong><span>صفحات واضحة ومحتوى منشور.</span></li><li><strong>عرض الدورات</strong><span>وصف وسعر وسياسة تسجيل.</span></li><li><strong>القبول والبدء</strong><span>مقعد ودعوة ووصول صحيح.</span></li><li><strong>التعلّم والنتيجة</strong><span>حضور وتقييم وإكمال وشهادة.</span></li></ol></section>
      {access.components?.lms===true&&<section className={styles.portals}><header><h2>روابط الدخول</h2><p>شارك الرابط المناسب مع كل مستخدم.</p></header><div className={styles.portalsList}><Link className={styles.portalCard} href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy`}><span><AcademyIcon name="user"/></span><div><strong>دخول المتدربين</strong><small>الدورات والمواعيد والنتائج</small></div><AcademyIcon name="arrow" size={16}/></Link><Link className={styles.portalCard} href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy&role=instructor`}><span><AcademyIcon name="teaching"/></span><div><strong>دخول المحاضرين</strong><small>الدفعات والحضور والتقييم</small></div><AcademyIcon name="arrow" size={16}/></Link></div></section>}
    </div>}
  </div>;
}
