import OdeirBrand from './odeir-brand';
import AcademyIcon from './academy-icon';
import styles from './academy-auth.module.css';

const experiences={
  manager:{
    eyebrow:'إدارة المنشأة والتدريب',
    title:'كل أدوات منشأتك في مساحة واحدة واضحة.',
    description:'أدر الموقع والمتجر وتجربة التعلّم، وانتقل إلى لوحة أودير التشغيلية من دون تشتت.',
    points:[['website','الموقع والمتجر','انشر المحتوى وتابع الطلبات من نفس المساحة.'],['courses','التدريب','أدر الدورات والمتدربين والمحاضرين والتقييمات.'],['chart','التشغيل','افتح بيانات المنشأة المصرح بها في أودير.']]
  },
  learner:{
    eyebrow:'بوابة المتدرب',
    title:'تعلمك واضح من أول دخول حتى الشهادة.',
    description:'شاهد خطوتك التالية، وابدأ المحتوى، وتابع المواعيد والنتائج من مكان واحد.',
    points:[['courses','دوراتك','الوصول إلى المحتوى المسند لك فقط.'],['schedule','مواعيدك','اللقاءات والحضور أمامك بوضوح.'],['compliance','إنجازك','التقدم والنتائج والشهادات في مسار واحد.']]
  },
  instructor:{
    eyebrow:'بوابة المحاضر',
    title:'إدارة يومك التدريبي بدون خطوات زائدة.',
    description:'تابع دفعاتك، سجل الحضور، وقيّم أعمال المتدربين في واجهة مركزة.',
    points:[['learners','دفعاتك','قوائم المتدربين حسب الدورات المسندة لك.'],['schedule','الحضور','تسجيل سريع وواضح لكل لقاء.'],['assessments','التقييم','الواجبات والملاحظات في مساحة واحدة.']]
  }
};

export default function AcademyAuthShell({experience='manager',tenantName='',children}){
  const content=experiences[experience]||experiences.manager;
  return <main className={styles.page} dir="rtl">
    <section className={styles.visual} aria-label="عن منصة أودير التدريبية">
      <div className={styles.brand}><OdeirBrand subtitle="إدارة المنشأة والتدريب"/></div>
      <div className={styles.visualCopy}>
        <span className={styles.eyebrow}>{content.eyebrow}</span>
        <h1>{content.title}</h1>
        <p>{content.description}</p>
        <div className={styles.points}>{content.points.map(([icon,title,description])=><article key={title}><span><AcademyIcon name={icon}/></span><div><strong>{title}</strong><small>{description}</small></div></article>)}</div>
      </div>
      <footer><span className={styles.secure}><AcademyIcon name="compliance" size={16}/> دخول آمن ومحتوى حسب الصلاحية</span>{tenantName&&<strong>{tenantName}</strong>}</footer>
    </section>
    <section className={styles.formSide}><div className={styles.formCard}>{children}</div><p className={styles.support}>تحتاج مساعدة؟ تواصل مع مسؤول المنصة في منشأتك.</p></section>
  </main>;
}
