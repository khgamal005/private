import Link from 'next/link';

export default function LegalPageShell({
  eyebrow,title,intro,notice,sections,english
}){
  return <main className="odeir-legal-page">
    <header className="odeir-legal-header">
      <Link className="odeir-legal-brand" href="/" aria-label="العودة إلى أودير">
        <span>O</span>
        <b>ODEIR</b>
      </Link>
      <nav aria-label="روابط السياسات">
        <Link href="/privacy">الخصوصية</Link>
        <Link href="/terms">الشروط</Link>
        <Link href="/data-deletion">حذف البيانات</Link>
      </nav>
    </header>

    <article className="odeir-legal-card">
      <div className="odeir-legal-hero">
        <small>{eyebrow}</small>
        <h1>{title}</h1>
        <p>{intro}</p>
        <time dateTime="2026-08-25">آخر تحديث: 25 أغسطس 2026</time>
      </div>

      {notice?<aside className="odeir-legal-notice" aria-live="polite">
        <small>{notice.label}</small>
        <code dir="ltr">{notice.value}</code>
        <p>{notice.description}</p>
      </aside>:null}

      <div className="odeir-legal-sections">
        {sections.map(section=><section key={section.title}>
          <h2>{section.title}</h2>
          {section.paragraphs?.map((paragraph,index)=><p key={index}>{paragraph}</p>)}
          {section.items?.length?<ul>
            {section.items.map(item=><li key={item}>{item}</li>)}
          </ul>:null}
        </section>)}
      </div>

      {english?<section className="odeir-legal-english" dir="ltr" lang="en">
        <small>ENGLISH SUMMARY</small>
        <h2>{english.title}</h2>
        {english.paragraphs.map((paragraph,index)=><p key={index}>{paragraph}</p>)}
      </section>:null}

      <footer className="odeir-legal-contact">
        <div>
          <small>مسؤول الخصوصية والدعم القانوني</small>
          <b>Marktone — ODEIR</b>
        </div>
        <a href="mailto:admin@marktone.sa">admin@marktone.sa</a>
      </footer>
    </article>
  </main>;
}

