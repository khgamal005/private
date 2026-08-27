'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import PageDocumentRenderer from './page-document-renderer';
import OdeirBrand from './odeir-brand';
import {OdeirSiteFooter,OdeirSiteHeader} from './odeir-site-chrome';
import {buildMenuTree,formatCmsDate} from '../lib/cms';
import publicStyles from './public-site.module.css';
import styles from './built-public-page.module.css';

export default function BuiltPublicPage({snapshot,content,preview=false}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const document=content?.content||content?.document||{};
  const managed=isOdeirSite(site);
  return <div className={`${publicStyles.site} ${managed?'odeir-experience odeir-managed-page':''}`} dir="rtl" style={themeVariables(site.theme)} data-site-chrome={managed?'odeir-managed':'tenant-managed'}>
    {preview&&<div className={styles.previewBanner}><strong>معاينة المسودة</strong><span>هذه النسخة غير ظاهرة للزوار حتى الضغط على «نشر».</span><button type="button" onClick={()=>window.close()}>إغلاق المعاينة</button></div>}
    {managed
      ?<div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings} hero={{primaryLabel:settings.contactCtaLabel,primaryHref:settings.contactCtaUrl}}/></div>
      :<Header menu={menu} settings={settings} site={site}/>}
    <main className={styles.builderMain}>
      <PageDocumentRenderer document={document} siteKey={site.key}/>
    </main>
    {managed?<OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>:<Footer menu={footerMenu} settings={settings} site={site}/>}
  </div>;
}

export function CmsArticlesIndex({snapshot}){
  const site=snapshot?.site||{};
  const settings=site.settings||{};
  const articles=Array.isArray(snapshot?.articles)?snapshot.articles:[];
  const menu=Array.isArray(snapshot?.menu)?snapshot.menu:[];
  const footerMenu=Array.isArray(snapshot?.footerMenu)&&snapshot.footerMenu.length?snapshot.footerMenu:menu;
  const managed=isOdeirSite(site);
  return <div className={`${publicStyles.site} ${managed?'odeir-experience odeir-managed-page':''}`} dir="rtl" style={themeVariables(site.theme)} data-site-chrome={managed?'odeir-managed':'tenant-managed'}>
    {managed
      ?<div className="odeir-managed-header-shell"><OdeirSiteHeader menu={menu} settings={settings} hero={{primaryLabel:settings.contactCtaLabel,primaryHref:settings.contactCtaUrl}}/></div>
      :<Header menu={menu} settings={settings} site={site}/>}
    <main className={styles.articlesMain}>
      <section className={styles.articlesHero}>
        <p>المعرفة والخبرة</p>
        <h1>{settings.articlesTitle||'مقالات ورؤى عملية'}</h1>
        <span>{settings.articlesDescription||'محتوى يساعد أصحاب القرار على تطوير المبيعات والتشغيل والتسويق والبيانات.'}</span>
      </section>
      <section className={styles.articleGrid}>
        {articles.map(article=><ArticleCard key={article.id||article.slug} article={article} site={site}/>)}
        {!articles.length&&<div className={styles.emptyArticles}><strong>لا توجد مقالات منشورة بعد</strong><span>ستظهر المقالات هنا فور نشرها من لوحة إدارة الموقع.</span></div>}
      </section>
    </main>
    {managed?<OdeirSiteFooter footerMenu={footerMenu} settings={settings}/>:<Footer menu={footerMenu} settings={settings} site={site}/>}
  </div>;
}

function Header({menu,settings,site}){
  const [open,setOpen]=useState(false);
  const [expanded,setExpanded]=useState('');
  const tree=useMemo(()=>buildMenuTree(menu),[menu]);
  const tenantPrefix=sitePrefix(site);
  return <header className={`${publicStyles.header} ${styles.smartHeader}`}>
    <div className={publicStyles.headerInner}>
      <SiteBrand site={site} settings={settings}/>
      <nav className={`${publicStyles.nav} ${styles.smartNav} ${open?publicStyles.navOpen:''}`} aria-label="القائمة الرئيسية">
        {tree.map(item=><MenuNode key={item.id||`${item.label}-${item.href}`} item={item} tenantPrefix={tenantPrefix} expanded={expanded} setExpanded={setExpanded} close={()=>setOpen(false)}/>)}
      </nav>
      <div className={publicStyles.headerActions}>
        <SmartLink href={settings.customerLoginUrl||'/login'} className={publicStyles.loginButton}>{settings.customerLoginLabel||'تسجيل دخول المنشآت'}</SmartLink>
        <SmartLink href={settings.contactCtaUrl||'/free-trial/apply'} className={publicStyles.primaryButton}>{settings.contactCtaLabel||'سجّل منشأتك مجانًا'}<span>↗</span></SmartLink>
      </div>
      <button type="button" className={publicStyles.menuToggle} aria-expanded={open} aria-label={open?'إغلاق القائمة':'فتح القائمة'} onClick={()=>setOpen(value=>!value)}><span/><span/><span/></button>
    </div>
  </header>;
}

function MenuNode({item,tenantPrefix,expanded,setExpanded,close}){
  const children=item.children||[];
  const hasChildren=children.length>0;
  const open=expanded===item.id;
  const href=rewriteHref(item.href,tenantPrefix);
  if(!hasChildren)return <SmartLink href={href} newTab={item.openInNewTab} onClick={close} className={item.cssClass||''}>
    {item.icon&&<span className={styles.menuIcon}>{item.icon}</span>}{item.label}{item.badge&&<small className={styles.menuBadge}>{item.badge}</small>}
  </SmartLink>;
  const columns=Math.max(1,Math.min(6,Number(item.megaSettings?.columns)||Math.max(...children.map(child=>Number(child.columnIndex)||1),1)));
  return <div className={`${styles.menuParent} ${item.isMega?styles.megaParent:styles.dropdownParent} ${open?styles.mobileExpanded:''}`}>
    <div className={styles.menuParentLabel}>
      <SmartLink href={href} onClick={event=>{if(href==='#')event.preventDefault();else close();}}>{item.icon&&<span className={styles.menuIcon}>{item.icon}</span>}{item.label}{item.badge&&<small className={styles.menuBadge}>{item.badge}</small>}</SmartLink>
      <button type="button" aria-expanded={open} aria-label={`فتح قائمة ${item.label}`} onClick={()=>setExpanded(value=>value===item.id?'':item.id)}>⌄</button>
    </div>
    {item.isMega
      ?<div className={styles.megaMenu} style={{'--mega-columns':columns}}>
        {Array.from({length:columns},(_,index)=>{
          const columnItems=children.filter(child=>(Number(child.columnIndex)||1)===index+1);
          return <div className={styles.megaColumn} key={index}>{columnItems.map(child=><MegaItem key={child.id} item={child} tenantPrefix={tenantPrefix} close={close}/>)}</div>;
        })}
        {item.imageUrl&&<div className={styles.megaFeature} style={{backgroundImage:`linear-gradient(180deg,transparent,rgba(4,18,35,.88)),url(${safeImage(item.imageUrl)})`}}><strong>{item.label}</strong><span>{item.description}</span></div>}
      </div>
      :<div className={styles.dropdownMenu}>{children.map(child=><div key={child.id} className={styles.dropdownItem}><MenuNode item={child} tenantPrefix={tenantPrefix} expanded={expanded} setExpanded={setExpanded} close={close}/></div>)}</div>}
  </div>;
}

function MegaItem({item,tenantPrefix,close}){
  const href=rewriteHref(item.href,tenantPrefix);
  if(item.kind==='group')return <div className={styles.megaGroup}><strong>{item.icon&&<span>{item.icon}</span>}{item.label}</strong>{item.description&&<p>{item.description}</p>}{(item.children||[]).map(child=><MegaItem key={child.id} item={child} tenantPrefix={tenantPrefix} close={close}/>)}</div>;
  return <SmartLink href={href} newTab={item.openInNewTab} onClick={close} className={styles.megaLink}>
    {item.imageUrl&&<span className={styles.megaThumb} style={{backgroundImage:`url(${safeImage(item.imageUrl)})`}}/>}
    <span><b>{item.icon&&<i>{item.icon}</i>}{item.label}{item.badge&&<em>{item.badge}</em>}</b>{item.description&&<small>{item.description}</small>}</span>
  </SmartLink>;
}

function Footer({menu,settings,site}){
  const tree=useMemo(()=>buildMenuTree(menu),[menu]);
  const prefix=sitePrefix(site);
  return <footer className={publicStyles.footer}>
    <div className={publicStyles.footerTop}>
      <div><SiteLogo site={site} settings={settings}/><p>{settings.footerText||`${site.nameAr||'الموقع'} — تجربة رقمية متكاملة.`}</p></div>
      <nav aria-label="روابط الموقع">{tree.slice(0,10).map(item=><SmartLink key={item.id} href={rewriteHref(item.href,prefix)}>{item.label}</SmartLink>)}<SmartLink href={settings.customerLoginUrl||'/login'}>تسجيل دخول المنشآت</SmartLink></nav>
      <div className={publicStyles.footerContact}><strong>تواصل معنا</strong>{settings.contactEmail&&<a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a>}{settings.contactPhone&&<a href={`tel:${settings.contactPhone}`}>{settings.contactPhone}</a>}{settings.country&&<span>{settings.country}</span>}</div>
    </div>
    <div className={publicStyles.footerBottom}><span>© {new Date().getFullYear()} {site.nameAr||'أودير'}. جميع الحقوق محفوظة.</span><span>ODEIR — تشغيل أوضح للمنشآت.</span></div>
  </footer>;
}

function SiteBrand({site,settings}){const prefix=sitePrefix(site);return <Link href={settings.homeUrl||prefix||'/'} className={`${publicStyles.brand} ${styles.siteBrand}`} aria-label={`${site.nameAr||'الموقع'} - الرئيسية`}><SiteLogo site={site} settings={settings}/></Link>}
function SiteLogo({site,settings}){
  if(settings.logoUrl)return <img src={safeImage(settings.logoUrl)} alt={site.nameAr||site.nameEn||'Logo'} className={styles.customLogo}/>;
  if(site.key==='marktone-main'||settings.brandKey==='odeir')return <OdeirBrand subtitle="منصة إدارة المنشآت"/>;
  return <span className={styles.textLogo}><b>{site.nameAr||'الموقع'}</b><small>Powered by ODEIR</small></span>;
}
function ArticleCard({article,site}){const prefix=sitePrefix(site);return <Link href={`${prefix}/articles/${encodeURIComponent(article.slug)}`} className={styles.articleCard}><div className={styles.articleCover} style={article.coverUrl?{backgroundImage:`url(${safeImage(article.coverUrl)})`}:undefined}><span>{article.category||'مقال'}</span>{article.featured&&<b>مميز</b>}</div><div><small>{formatCmsDate(article.publishedAt,{time:false})}{article.readingMinutes?` · ${article.readingMinutes} دقائق`:''}</small><h2>{article.title}</h2><p>{article.excerpt||'اقرأ المقال الكامل واكتشف التفاصيل.'}</p><strong>قراءة المقال ←</strong></div></Link>}
function SmartLink({href='#',children,className='',newTab=false,onClick}){const target=safeHref(href)||'#';const external=/^https?:\/\//i.test(target);if(external||target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:'))return <a href={target} className={className} target={newTab?'_blank':undefined} rel={newTab?'noreferrer':undefined} onClick={onClick}>{children}</a>;return <Link href={target} className={className} target={newTab?'_blank':undefined} rel={newTab?'noreferrer':undefined} onClick={onClick}>{children}</Link>}
function sitePrefix(site){return String(site?.key||'').startsWith('tenant:')?`/site/${encodeURIComponent(String(site.key).slice(7))}`:''}
function rewriteHref(href,prefix){const target=safeHref(href)||'#';if(!prefix)return target;if(target==='/')return prefix;if(target.startsWith('/p/')||target==='/articles'||target.startsWith('/articles/'))return `${prefix}${target}`;return target}
function safeHref(value){const href=String(value||'').trim();return /^(javascript|data|vbscript):/i.test(href)?'':href}
function safeImage(value){const url=String(value||'').trim();return /^(javascript|data:text\/html|vbscript):/i.test(url)?'':url.replace(/["'()]/g,encodeURIComponent)}
function isOdeirSite(site){return site?.key==='marktone-main'}
function themeVariables(theme={}){return {'--mt-navy':theme.navy||'#06182e','--mt-navy-soft':theme.navySoft||'#0b2949','--mt-gold':theme.gold||'#e6b34e','--mt-paper':theme.paper||'#f7f2e8','--mt-white':theme.white||'#fff'}}
