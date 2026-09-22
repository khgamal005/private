'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {academyBasePath,academyNavigation} from '../lib/academy-navigation.mjs';
import styles from './academy-shell.module.css';

export default function AcademyShell({access,children}){
  const pathname=usePathname();
  const [menuOpen,setMenuOpen]=useState(false);
  const tenant=access.tenant;
  const base=academyBasePath(tenant.slug);
  const items=academyNavigation(access);
  const websiteEnabled=access.components?.website===true;
  const isActive=href=>href===base||href===`${base}/lms`
    ?pathname===href
    :pathname===href||pathname.startsWith(`${href}/`);
  return <div className={styles.shell} dir="rtl">
    {menuOpen&&<button type="button" className={styles.backdrop} onClick={()=>setMenuOpen(false)} aria-label="إغلاق قائمة المنصة"/>}
    <aside id="academy-navigation" className={`${styles.sidebar} ${menuOpen?styles.sidebarOpen:''}`}>
      <div className={styles.brand}><span className={styles.brandIcon} aria-hidden="true">م</span><div><strong>منصة ماركتون</strong><small>الموقع والتدريب التفاعلي</small></div><button type="button" className={styles.closeMenu} aria-label="إغلاق القائمة" onClick={()=>setMenuOpen(false)}>×</button></div>
      <div className={styles.tenant}><span>مساحة المنشأة</span><strong>{tenant.name}</strong></div>
      <nav className={styles.navigation} aria-label="إدارة المنصة التدريبية">
        {items.map(item=><Link key={item.key} href={item.href} aria-current={isActive(item.href)?'page':undefined} className={isActive(item.href)?styles.active:''} onClick={()=>setMenuOpen(false)}>{item.label}</Link>)}
      </nav>
      <div className={styles.sidebarFooter}><span>{access.mode==='standalone'?'اشتراك المنصة التدريبية':'منصة تدريب مرتبطة بأودير'}</span><p>إدارة الموقع وتجربة التعلّم من مكان واحد.</p></div>
    </aside>
    <div className={styles.main}>
      <header className={styles.topbar}>
        <div className={styles.heading}><button type="button" className={styles.menuToggle} aria-label="فتح قائمة المنصة" aria-controls="academy-navigation" aria-expanded={menuOpen} onClick={()=>setMenuOpen(true)}><span/><span/><span/></button><div><small>إدارة المنصة التدريبية</small><h1>{tenant.name}</h1></div></div>
        <div className={styles.tools}>
          {websiteEnabled&&<Link className={styles.secondaryButton} href={`/site/${encodeURIComponent(tenant.slug)}`} target="_blank" rel="noopener noreferrer">عرض الموقع <span aria-hidden="true">↗</span></Link>}
          {access.components?.store===true&&<Link className={styles.secondaryButton} href={`/site/${encodeURIComponent(tenant.slug)}/courses`} target="_blank" rel="noopener noreferrer">عرض المتجر <span aria-hidden="true">↗</span></Link>}
          {access.odeirAccess===true&&<Link className={styles.secondaryButton} href={`/tenant/${encodeURIComponent(tenant.slug)}`}>تشغيل المنشأة في أودير</Link>}
          <form action="/api/auth/logout" method="post"><input type="hidden" name="workspace" value="academy"/><button type="submit" className={styles.logout}>تسجيل الخروج</button></form>
        </div>
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  </div>;
}
