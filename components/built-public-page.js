'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useState} from 'react';
import PageDocumentRenderer from './page-document-renderer';
import publicStyles from './public-site.module.css';
import styles from './built-public-page.module.css';

export default function BuiltPublicPage({snapshot,content,preview=false}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const document=content?.content||content?.document||{};
  return <div className={publicStyles.site} dir="rtl" style={themeVariables(site.theme)}>
    {preview&&<div className={styles.previewBanner}><strong>معاينة المسودة</strong><span>هذه النسخة غير ظاهرة للزوار حتى الضغط على «نشر».</span><button type="button" onClick={()=>window.close()}>إغلاق المعاينة</button></div>}
    <Header menu={menu} settings={settings}/>
    <main className={styles.builderMain}>
      <PageDocumentRenderer document={document}/>
    </main>
    <Footer menu={menu} settings={settings}/>
  </div>;
}

function Header({menu,settings}){
  const [open,setOpen]=useState(false);
  return <header className={publicStyles.header}>
    <div className={publicStyles.headerInner}>
      <Link href="/" className={publicStyles.brand} aria-label="ماركتون - الرئيسية"><Image src="/marktone-logo-light.svg" alt="Marktone" width={802} height={221} priority/></Link>
      <nav className={`${publicStyles.nav} ${open?publicStyles.navOpen:''}`} aria-label="القائمة الرئيسية">{menu.map(item=><SmartLink key={item.id||`${item.label}-${item.href}`} href={item.href} newTab={item.openInNewTab} onClick={()=>setOpen(false)}>{item.label}</SmartLink>)}</nav>
      <div className={publicStyles.headerActions}><SmartLink href={settings.customerLoginUrl||'/login'} className={publicStyles.loginButton}>{settings.customerLoginLabel||'دخول العملاء'}</SmartLink><SmartLink href={settings.contactCtaUrl||'#contact'} className={publicStyles.primaryButton}>{settings.contactCtaLabel||'تواصل معنا'}<span>↗</span></SmartLink></div>
      <button type="button" className={publicStyles.menuToggle} aria-expanded={open} aria-label={open?'إغلاق القائمة':'فتح القائمة'} onClick={()=>setOpen(value=>!value)}><span/><span/><span/></button>
    </div>
  </header>;
}
function Footer({menu,settings}){return <footer className={publicStyles.footer}><div className={publicStyles.footerTop}><div><Image src="/marktone-logo-light.svg" alt="Marktone" width={802} height={221}/><p>{settings.footerText||'ماركتون — منظومة تشغيل ونمو متخصصة.'}</p></div><nav aria-label="روابط الموقع">{menu.map(item=><SmartLink key={item.id||`${item.label}-${item.href}`} href={item.href}>{item.label}</SmartLink>)}<Link href="/articles">المقالات</Link><SmartLink href={settings.customerLoginUrl||'/login'}>دخول العملاء</SmartLink></nav><div className={publicStyles.footerContact}><strong>تواصل مع ماركتون</strong>{settings.contactEmail&&<a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a>}{settings.contactPhone&&<a href={`tel:${settings.contactPhone}`}>{settings.contactPhone}</a>}{settings.country&&<span>{settings.country}</span>}</div></div><div className={publicStyles.footerBottom}><span>© {new Date().getFullYear()} ماركتون. جميع الحقوق محفوظة.</span><span>تشغيل ونمو مبنيان على البيانات.</span></div></footer>}
function SmartLink({href='#',children,className='',newTab=false,onClick}){const target=safeHref(href)||'#';const external=/^https?:\/\//i.test(target);if(external||target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:'))return <a href={target} className={className} target={newTab?'_blank':undefined} rel={newTab?'noreferrer':undefined} onClick={onClick}>{children}</a>;return <Link href={target} className={className} target={newTab?'_blank':undefined} rel={newTab?'noreferrer':undefined} onClick={onClick}>{children}</Link>}
function safeHref(value){const href=String(value||'').trim();return /^(javascript|data|vbscript):/i.test(href)?'':href}
function themeVariables(theme={}){return {'--mt-navy':theme.navy||'#06182e','--mt-navy-soft':theme.navySoft||'#0b2949','--mt-gold':theme.gold||'#e6b34e','--mt-paper':theme.paper||'#f7f2e8','--mt-white':theme.white||'#fff'}}
