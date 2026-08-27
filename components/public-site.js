'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useMemo,useState} from 'react';
import OdeirBrand from './odeir-brand';
import {OdeirSiteFooter,OdeirSiteHeader} from './odeir-site-chrome';
import styles from './public-site.module.css';

const ICONS=['◌','↗','◎','◇','✦','⌁','▦','↳'];

export default function PublicSite({snapshot}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const sections=Array.isArray(snapshot?.sections)?snapshot.sections:[];
  const articles=Array.isArray(snapshot?.articles)?snapshot.articles:[];
  const managed=isOdeirSite(site);

  return <div className={`${styles.site} ${managed?'odeir-experience odeir-managed-page':''}`} dir="rtl" style={themeVariables(site.theme)} data-site-chrome={managed?'odeir-managed':'tenant-managed'}>
    {managed
      ?<div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings} hero={{primaryLabel:settings.contactCtaLabel,primaryHref:settings.contactCtaUrl}}/></div>
      :<PublicHeader menu={menu} settings={settings}/>}
    <main>
      {sections.map(section=><Section key={section.id||section.key} section={section}/>) }
      {articles.length>0&&<ArticlesPreview articles={articles}/>} 
    </main>
    {managed?<OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>:<PublicFooter menu={footerMenu} settings={settings}/>}
  </div>;
}

export function PublicContentPage({snapshot,content,type='page'}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const managed=isOdeirSite(site);
  const label=type==='article'?'مقالات أودير':'أودير';
  return <div className={`${styles.site} ${managed?'odeir-experience odeir-managed-page':''}`} dir="rtl" style={themeVariables(site.theme)} data-site-chrome={managed?'odeir-managed':'tenant-managed'}>
    {managed
      ?<div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings} hero={{primaryLabel:settings.contactCtaLabel,primaryHref:settings.contactCtaUrl}}/></div>
      :<PublicHeader menu={menu} settings={settings}/>}
    <main className={styles.contentMain}>
      <article className={styles.contentArticle}>
        <div className={styles.contentMeta}>
          <Link href="/">الرئيسية</Link><span>/</span>
          {type==='article'&&<><Link href="/articles">المقالات</Link><span>/</span></>}
          <span>{label}</span>
        </div>
        {content?.coverUrl&&<div className={styles.contentCover} style={{backgroundImage:`url(${content.coverUrl})`}}/>}
        <p className={styles.eyebrow}>{content?.category||label}</p>
        <h1>{content?.title}</h1>
        {content?.excerpt&&<p className={styles.contentLead}>{content.excerpt}</p>}
        {type==='article'&&(content?.authorName||content?.publishedAt)&&<div className={styles.byline}>
          {content.authorName&&<span>{content.authorName}</span>}
          {content.publishedAt&&<time>{formatDate(content.publishedAt)}</time>}
        </div>}
        <div className={styles.richText}>{textBlocks(content?.body)}</div>
      </article>
    </main>
    {managed?<OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>:<PublicFooter menu={footerMenu} settings={settings}/>}
  </div>;
}

export function ArticlesIndex({snapshot}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const articles=Array.isArray(snapshot?.articles)?snapshot.articles:[];
  const managed=isOdeirSite(site);
  return <div className={`${styles.site} ${managed?'odeir-experience odeir-managed-page':''}`} dir="rtl" style={themeVariables(site.theme)} data-site-chrome={managed?'odeir-managed':'tenant-managed'}>
    {managed
      ?<div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings} hero={{primaryLabel:settings.contactCtaLabel,primaryHref:settings.contactCtaUrl}}/></div>
      :<PublicHeader menu={menu} settings={settings}/>}
    <main className={styles.contentMain}>
      <section className={styles.articlesIndex}>
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>رؤى عملية</p>
          <h1>مقالات أودير</h1>
          <p>محتوى لأصحاب القرار حول النمو والتشغيل والمبيعات والبيانات في قطاع التدريب والمؤسسات.</p>
        </div>
        <div className={styles.articleGrid}>
          {articles.map(article=><ArticleCard key={article.id||article.slug} article={article}/>)}
          {!articles.length&&<div className={styles.emptyPublic}>سيتم نشر المقالات هنا قريبًا.</div>}
        </div>
      </section>
    </main>
    {managed?<OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>:<PublicFooter menu={footerMenu} settings={settings}/>}
  </div>;
}

function PublicHeader({menu,settings}){
  const [open,setOpen]=useState(false);
  const loginUrl=settings.customerLoginUrl||'/login';
  const freeTrialUrl=settings.freeTrialUrl||'/free-trial';
  return <header className={styles.header}>
    <div className={styles.headerInner}>
      <Link href="/" className={styles.brand} aria-label="أودير - الرئيسية">
        <OdeirBrand subtitle="منصة إدارة المنشآت"/>
      </Link>
      <nav className={`${styles.nav} ${open?styles.navOpen:''}`} aria-label="القائمة الرئيسية">
        {menu.map(item=><SmartLink key={item.id||`${item.label}-${item.href}`} href={item.href} newTab={item.openInNewTab} onClick={()=>setOpen(false)}>{item.label}</SmartLink>)}
      </nav>
      <div className={styles.headerActions}>
        <SmartLink href={loginUrl} className={styles.loginButton}>{settings.customerLoginLabel||'تسجيل دخول المنشآت'}</SmartLink>
        <SmartLink href={freeTrialUrl} className={styles.primaryButton}>{settings.freeTrialLabel||'سجّل منشأتك مجانًا'}<span>↗</span></SmartLink>
      </div>
      <button type="button" className={styles.menuToggle} aria-expanded={open} aria-label={open?'إغلاق القائمة':'فتح القائمة'} onClick={()=>setOpen(value=>!value)}>
        <span/><span/><span/>
      </button>
    </div>
  </header>;
}

function PublicFooter({menu,settings}){
  return <footer className={styles.footer}>
    <div className={styles.footerTop}>
      <div>
        <OdeirBrand subtitle="منصة إدارة المنشآت"/>
        <p>{settings.footerText||'أودير — تشغيل أوضح وإدارة مترابطة للمنشآت.'}</p>
      </div>
      <nav aria-label="روابط الموقع">
        {menu.map(item=><SmartLink key={item.id||`${item.label}-${item.href}`} href={item.href}>{item.label}</SmartLink>)}
        <Link href="/free-trial/apply">سجّل منشأتك مجانًا</Link>
        <SmartLink href={settings.customerLoginUrl||'/login'}>تسجيل دخول المنشآت</SmartLink>
      </nav>
      <div className={styles.footerContact}>
        <strong>تواصل مع أودير</strong>
        {settings.contactEmail&&<a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a>}
        {settings.contactPhone&&<a href={`tel:${settings.contactPhone}`}>{settings.contactPhone}</a>}
        {settings.country&&<span>{settings.country}</span>}
      </div>
    </div>
    <div className={styles.footerBottom}><span>© {new Date().getFullYear()} أودير. جميع الحقوق محفوظة.</span><span>تشغيل أوضح للمنشآت.</span></div>
  </footer>;
}

function Section({section}){
  const type=section.type||'cards';
  if(type==='hero')return <Hero section={section}/>;
  if(type==='contact')return <Contact section={section}/>;
  if(type==='partnership')return <Partnership section={section}/>;
  if(type==='comparison')return <Comparison section={section}/>;
  if(type==='process')return <Process section={section}/>;
  if(type==='system')return <SystemSection section={section}/>;
  return <CardsSection section={section}/>;
}

function Hero({section}){
  const items=Array.isArray(section.items)?section.items:[];
  return <section id={section.key||'home'} className={`${styles.section} ${styles.hero}`}>
    <div className={styles.heroGlow}/>
    <div className={styles.heroInner}>
      <div className={styles.heroCopy}>
        {section.eyebrow&&<p className={styles.eyebrow}>{section.eyebrow}</p>}
        <h1>{section.title}</h1>
        {section.summary&&<p className={styles.heroLead}>{section.summary}</p>}
        {section.body&&<p className={styles.heroBody}>{section.body}</p>}
        <div className={styles.ctaRow}>
          <Cta cta={section.primaryCta} primary/>
          <Cta cta={section.secondaryCta}/>
        </div>
        <div className={styles.heroProof}>
          {items.slice(0,2).map((item,index)=><div key={`${item.title}-${index}`}><span>{index?'02':'01'}</span><strong>{item.title}</strong><small>{item.description}</small></div>)}
        </div>
      </div>
      <div className={styles.heroVisual} aria-hidden="true">
        <div className={styles.orbitOuter}/><div className={styles.orbitMiddle}/><div className={styles.orbitInner}/>
        <div className={styles.coreMark}><Image src="/marktone-mark.svg" alt="" width={96} height={96}/></div>
        <div className={`${styles.orbitLabel} ${styles.labelOne}`}><span>استراتيجية</span><b>01</b></div>
        <div className={`${styles.orbitLabel} ${styles.labelTwo}`}><span>تشغيل</span><b>02</b></div>
        <div className={`${styles.orbitLabel} ${styles.labelThree}`}><span>بيانات</span><b>03</b></div>
        <div className={styles.visualCaption}><small>{section.media?.badge||'منظومة مترابطة'}</small><strong>{section.media?.caption||'رؤية واحدة للنمو'}</strong></div>
      </div>
    </div>
    <div className={styles.scrollCue}><span>اكتشف المنظومة</span><i>↓</i></div>
  </section>;
}

function CardsSection({section}){
  const items=Array.isArray(section.items)?section.items:[];
  const dark=section.variant==='dark';
  return <section id={section.key} className={`${styles.section} ${dark?styles.darkSection:section.variant==='paper'?styles.paperSection:styles.lightSection}`}>
    <div className={styles.sectionInner}>
      <SectionHeading section={section}/>
      <div className={`${styles.cardGrid} ${items.length>=6?styles.sixGrid:''}`}>
        {items.map((item,index)=><article key={`${item.title}-${index}`} className={styles.infoCard}>
          <div className={styles.cardIcon}>{ICONS[index%ICONS.length]}</div>
          <span className={styles.cardNumber}>{String(index+1).padStart(2,'0')}</span>
          <h3>{item.title}</h3><p>{item.description}</p>
        </article>)}
      </div>
      {section.primaryCta?.label&&<div className={styles.centerCta}><Cta cta={section.primaryCta} primary={!dark}/></div>}
    </div>
  </section>;
}

function SystemSection({section}){
  const items=Array.isArray(section.items)?section.items:[];
  return <section id={section.key} className={`${styles.section} ${styles.systemSection}`}>
    <div className={styles.sectionInner}>
      <SectionHeading section={section}/>
      <div className={styles.systemMap}>
        <div className={styles.systemCore}><Image src="/marktone-mark.svg" alt="" width={72} height={72}/><strong>أودير</strong><span>منظومة التشغيل</span></div>
        {items.map((item,index)=><article key={`${item.title}-${index}`} className={styles.systemNode} style={{'--node':index}}>
          <span>{String(index+1).padStart(2,'0')}</span><h3>{item.title}</h3><p>{item.description}</p>
        </article>)}
      </div>
      <div className={styles.centerCta}><Cta cta={section.primaryCta}/></div>
    </div>
  </section>;
}

function Process({section}){
  const items=Array.isArray(section.items)?section.items:[];
  return <section id={section.key} className={`${styles.section} ${styles.paperSection}`}>
    <div className={styles.sectionInner}>
      <SectionHeading section={section}/>
      <div className={styles.processLine}>
        {items.map((item,index)=><article key={`${item.title}-${index}`}>
          <div><span>{String(index+1).padStart(2,'0')}</span><i>{ICONS[index%ICONS.length]}</i></div>
          <h3>{item.title}</h3><p>{item.description}</p>
        </article>)}
      </div>
    </div>
  </section>;
}

function Comparison({section}){
  const items=Array.isArray(section.items)?section.items:[];
  return <section id={section.key} className={`${styles.section} ${styles.comparisonSection}`}>
    <div className={styles.sectionInner}>
      <SectionHeading section={section}/>
      <div className={styles.comparisonGrid}>
        {items.slice(0,2).map((item,index)=><article key={`${item.title}-${index}`} className={index?styles.afterCard:styles.beforeCard}>
          <span>{index?'الحالة المستهدفة':'الوضع الحالي'}</span><h3>{item.title}</h3>
          <ul>{splitList(item.description).map(point=><li key={point}>{point}</li>)}</ul>
        </article>)}
        <div className={styles.comparisonArrow}>←</div>
      </div>
    </div>
  </section>;
}

function Partnership({section}){
  return <section id={section.key} className={`${styles.section} ${styles.partnership}`}>
    <div className={styles.partnershipInner}>
      <div><p className={styles.eyebrow}>{section.eyebrow}</p><h2>{section.title}</h2><p>{section.summary}</p></div>
      <div className={styles.ctaRow}><Cta cta={section.primaryCta} primary/><Cta cta={section.secondaryCta}/></div>
    </div>
  </section>;
}

function Contact({section}){
  const [state,setState]=useState({status:'idle',message:'',reference:''});
  async function submit(event){
    event.preventDefault();
    const form=event.currentTarget;
    const values=Object.fromEntries(new FormData(form));
    setState({status:'loading',message:'',reference:''});
    try{
      const response=await fetch('/api/public/contact',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...values,consent:Boolean(values.consent),sourcePage:window.location.pathname})
      });
      const data=await response.json();
      if(!response.ok)throw new Error(data?.error||'تعذر إرسال الطلب');
      form.reset();
      setState({status:'success',message:data.message,reference:data.reference||''});
    }catch(error){
      setState({status:'error',message:error.message,reference:''});
    }
  }
  return <section id={section.key||'contact'} className={`${styles.section} ${styles.contactSection}`}>
    <div className={styles.contactInner}>
      <div className={styles.contactCopy}>
        <p className={styles.eyebrow}>{section.eyebrow}</p><h2>{section.title}</h2><p>{section.summary}</p>
        {section.body&&<small>{section.body}</small>}
        <div className={styles.contactPromise}><span>01</span><p><strong>نستمع أولًا</strong>نفهم الواقع قبل اقتراح الحل.</p></div>
        <div className={styles.contactPromise}><span>02</span><p><strong>نحدد الخطوة التالية</strong>تصور واضح للنطاق والأولوية ومؤشرات النجاح.</p></div>
      </div>
      <form className={styles.contactForm} onSubmit={submit}>
        <div className={styles.formGrid}>
          <label><span>الاسم *</span><input name="name" required minLength={2} maxLength={120}/></label>
          <label><span>اسم المنشأة</span><input name="organization" maxLength={160}/></label>
          <label><span>رقم الجوال</span><input name="phone" inputMode="tel" maxLength={40}/></label>
          <label><span>البريد الإلكتروني</span><input name="email" type="email" maxLength={254}/></label>
        </div>
        <label><span>ما التحدي الذي ترغب في حله؟ *</span><textarea name="message" required minLength={10} maxLength={5000} rows={5}/></label>
        <label className={styles.honeypot} aria-hidden="true"><span>Website</span><input name="website" tabIndex={-1} autoComplete="off"/></label>
        <label className={styles.consent}><input type="checkbox" name="consent" value="yes"/><span>أوافق على تواصل فريق أودير بخصوص هذا الطلب.</span></label>
        <button type="submit" disabled={state.status==='loading'}>{state.status==='loading'?'جارٍ الإرسال…':'إرسال طلب التواصل'}<span>↗</span></button>
        {state.message&&<p className={state.status==='success'?styles.formSuccess:styles.formError}>{state.message}{state.reference&&<small>رقم المرجع: {state.reference}</small>}</p>}
      </form>
    </div>
  </section>;
}

function ArticlesPreview({articles}){
  const visible=useMemo(()=>articles.slice(0,3),[articles]);
  return <section className={`${styles.section} ${styles.articlePreview}`}>
    <div className={styles.sectionInner}>
      <div className={styles.sectionHeading}><p className={styles.eyebrow}>المعرفة</p><h2>أحدث رؤى أودير</h2><p>أفكار عملية تساعد أصحاب القرار على بناء تشغيل أكثر وضوحًا ونمو أكثر استدامة.</p></div>
      <div className={styles.articleGrid}>{visible.map(article=><ArticleCard key={article.id||article.slug} article={article}/>)}</div>
      <div className={styles.centerCta}><Link className={styles.primaryButton} href="/articles">عرض جميع المقالات <span>↗</span></Link></div>
    </div>
  </section>;
}

function ArticleCard({article}){
  return <Link href={`/articles/${encodeURIComponent(article.slug)}`} className={styles.articleCard}>
    <div className={styles.articleImage} style={article.coverUrl?{backgroundImage:`url(${article.coverUrl})`}:undefined}><span>{article.category||'رؤى أودير'}</span></div>
    <div><time>{article.publishedAt?formatDate(article.publishedAt):'مقال'}</time><h3>{article.title}</h3><p>{article.excerpt}</p><strong>اقرأ المقال ←</strong></div>
  </Link>;
}

function SectionHeading({section}){
  return <div className={styles.sectionHeading}>
    {section.eyebrow&&<p className={styles.eyebrow}>{section.eyebrow}</p>}
    <h2>{section.title}</h2>{section.summary&&<p>{section.summary}</p>}{section.body&&<small>{section.body}</small>}
  </div>;
}
function Cta({cta,primary=false}){
  if(!cta?.label||!cta?.href)return null;
  return <SmartLink href={cta.href} className={primary?styles.primaryButton:styles.secondaryButton}>{cta.label}<span>↗</span></SmartLink>;
}
function SmartLink({href='#',children,className='',newTab=false,onClick}){
  const external=/^https?:\/\//i.test(href);
  const target=newTab?'_blank':undefined;
  const rel=newTab?'noreferrer':undefined;
  if(external||href.startsWith('#')||href.startsWith('mailto:')||href.startsWith('tel:')){
    return <a href={href} className={className} target={target} rel={rel} onClick={onClick}>{children}</a>;
  }
  return <Link href={href} className={className} target={target} rel={rel} onClick={onClick}>{children}</Link>;
}
function splitList(value){return String(value||'').split(/[،,؛;]/).map(item=>item.trim()).filter(Boolean);}
function textBlocks(value){
  return String(value||'').split(/\n{2,}/).filter(Boolean).map((block,index)=>{
    const lines=block.split('\n').filter(Boolean);
    if(lines.every(line=>/^[-•]/.test(line.trim()))){
      return <ul key={index}>{lines.map(line=><li key={line}>{line.replace(/^[-•]\s*/, '')}</li>)}</ul>;
    }
    const heading=lines.length===1&&lines[0].length<80&&/[:：]$/.test(lines[0]);
    return heading?<h2 key={index}>{lines[0].replace(/[:：]$/,'')}</h2>:<p key={index}>{lines.map((line,lineIndex)=><span key={`${line}-${lineIndex}`}>{line}{lineIndex<lines.length-1&&<br/>}</span>)}</p>;
  });
}
function formatDate(value){
  try{return new Intl.DateTimeFormat('ar-SA',{year:'numeric',month:'long',day:'numeric'}).format(new Date(value));}catch{return '';}
}
function isOdeirSite(site){return site?.key==='marktone-main'}
function themeVariables(theme={}){
  return {
    '--mt-navy':theme.navy||'#06182e','--mt-navy-soft':theme.navySoft||'#0b2949',
    '--mt-gold':theme.gold||'#e6b34e','--mt-paper':theme.paper||'#f7f2e8','--mt-white':theme.white||'#fff'
  };
}
