import Link from 'next/link';
import styles from './website-builder-home.module.css';

export default function WebsiteBuilderHome({pages=[]}){
  const rows=Array.isArray(pages)?pages:[];
  return <div className={styles.workspace} dir="rtl">
    <header className={styles.hero}>
      <div><span>ODEIR VISUAL BUILDER</span><h1>مصمم الصفحات</h1><p>صمم صفحات أودير بصريًا بالسحب والترتيب، واحفظ المسودة قبل نشرها على الموقع.</p></div>
      <div><Link href="/control/website">إدارة المحتوى</Link><Link className={styles.primary} href="/control/website">إنشاء صفحة جديدة +</Link></div>
    </header>
    <section className={styles.summary}>
      <article><strong>{rows.length}</strong><span>إجمالي الصفحات</span></article>
      <article><strong>{rows.filter(page=>page.status==='published').length}</strong><span>صفحات منشورة</span></article>
      <article><strong>{rows.filter(page=>page.template_key==='visual-builder').length}</strong><span>مصممة بصريًا</span></article>
    </section>
    <section className={styles.panel}>
      <header><div><h2>اختر الصفحة التي تريد تصميمها</h2><p>يظل الهيدر والفوتر عالميين ومحميين، بينما تتحكم في كل ما بينهما.</p></div></header>
      <div className={styles.grid}>
        {rows.map(page=><article key={page.id}>
          <div className={styles.pagePreview}><span>{page.template_key==='visual-builder'?'Visual':'Page'}</span><i/><i/><i/></div>
          <div className={styles.pageBody}>
            <div><small dir="ltr">/p/{page.slug}</small><Status value={page.status}/></div>
            <h3>{page.title}</h3><p>{page.excerpt||'صفحة أودير قابلة للتصميم المرئي.'}</p>
            <footer><Link className={styles.design} href={`/control/website/builder/page/${page.id}`}>فتح المصمم</Link>{page.status==='published'&&<Link href={`/p/${page.slug}`} target="_blank">عرض الصفحة ↗</Link>}</footer>
          </div>
        </article>)}
        {!rows.length&&<div className={styles.empty}><strong>لا توجد صفحات بعد</strong><p>أنشئ أول صفحة من إدارة الموقع، ثم ارجع إلى المصمم.</p><Link href="/control/website">فتح إدارة الموقع</Link></div>}
      </div>
    </section>
  </div>;
}
function Status({value}){return <span className={`${styles.status} ${value==='published'?styles.published:''}`}>{value==='published'?'منشور':value==='draft'?'مسودة':'مؤرشف'}</span>}
