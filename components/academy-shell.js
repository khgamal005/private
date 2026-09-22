'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {ACADEMY_NAVIGATION_GROUPS,academyBasePath,academyNavigation} from '../lib/academy-navigation.mjs';
import AcademyIcon from './academy-icon';
import OdeirBrand from './odeir-brand';
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
  const activeItem=items.find(item=>isActive(item.href))||items[0];
  const grouped=ACADEMY_NAVIGATION_GROUPS.map(group=>({...group,items:items.filter(item=>item.group===group.key)})).filter(group=>group.items.length);
  return <div className={styles.shell} dir="rtl">
    <a className={styles.skipLink} href="#academy-content">انتقل إلى المحتوى</a>
    {menuOpen&&<button type="button" className={styles.backdrop} onClick={()=>setMenuOpen(false)} aria-label="إغلاق قائمة المنصة"/>}
    <aside id="academy-navigation" className={`${styles.sidebar} ${menuOpen?styles.sidebarOpen:''}`}>
      <div className={styles.brand}><OdeirBrand compact subtitle="منصة المنشأة والتدريب"/><button type="button" className={styles.closeMenu} aria-label="إغلاق القائمة" onClick={()=>setMenuOpen(false)}><AcademyIcon name="close"/></button></div>
      <div className={styles.tenant}><span className={styles.tenantAvatar}>{tenant.name?.trim()?.[0]||'أ'}</span><div><small>مساحة المنشأة</small><strong>{tenant.name}</strong></div></div>
      <nav className={styles.navigation} aria-label="إدارة المنصة التدريبية">
        {grouped.map(group=><section className={styles.navGroup} key={group.key}><h2>{group.label}</h2>{group.items.map(item=><Link key={item.key} href={item.href} aria-current={isActive(item.href)?'page':undefined} className={isActive(item.href)?styles.active:''} onClick={()=>setMenuOpen(false)}><AcademyIcon name={item.icon}/><span>{item.label}</span>{isActive(item.href)&&<i aria-hidden="true"/>}</Link>)}</section>)}
      </nav>
      <div className={styles.sidebarFooter}><div><AcademyIcon name="compliance" size={17}/><span>{access.mode==='standalone'?'منصة تدريب مستقلة':'متصل بمنصة أودير'}</span></div><form action="/api/auth/logout" method="post"><input type="hidden" name="workspace" value="academy"/><button type="submit"><AcademyIcon name="logout" size={17}/> تسجيل الخروج</button></form></div>
    </aside>
    <div className={styles.main}>
      <header className={styles.topbar}>
        <div className={styles.heading}><button type="button" className={styles.menuToggle} aria-label="فتح قائمة المنصة" aria-controls="academy-navigation" aria-expanded={menuOpen} onClick={()=>setMenuOpen(true)}><AcademyIcon name="menu"/></button><div><small>منصة التدريب / {activeItem?.label}</small><h1>{tenant.name}</h1></div></div>
        <div className={styles.tools}>
          {websiteEnabled&&<Link className={styles.iconButton} href={`/site/${encodeURIComponent(tenant.slug)}`} target="_blank" rel="noopener noreferrer" title="عرض الموقع"><AcademyIcon name="website"/><span>الموقع</span></Link>}
          {access.components?.store===true&&<Link className={styles.iconButton} href={`/site/${encodeURIComponent(tenant.slug)}/courses`} target="_blank" rel="noopener noreferrer" title="عرض متجر الدورات"><AcademyIcon name="store"/><span>المتجر</span></Link>}
          {access.odeirAccess===true&&<Link className={styles.odeirButton} href={`/tenant/${encodeURIComponent(tenant.slug)}`}>فتح أودير <AcademyIcon name="arrow" size={16}/></Link>}
        </div>
      </header>
      <div id="academy-content" className={styles.content}>{children}</div>
    </div>
  </div>;
}
