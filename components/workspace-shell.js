'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useMemo,useState} from 'react';
import LogoutButton from './logout-button';
import MarktoneLogo from './marktone-logo';
import {WORKSPACE_KINDS} from '../lib/workspaces';

const icons={
  overview:'⌂',tenants:'▦',subscriptions:'◫',content:'▤',settings:'⚙',
  tasks:'✓',sales:'↗',incentives:'◎',people:'♙',news:'◧'
};

function tenantGroups(slug){
  const base=`/tenant/${encodeURIComponent(slug)}`;
  return [
    {label:'التشغيل اليومي',items:[
      {key:'overview',label:'لوحة المنشأة',href:base},
      {key:'tasks',label:'المهام والتقويم',href:`${base}/tasks`},
      {key:'sales',label:'المبيعات والعملاء',href:`${base}/sales`},
      {key:'incentives',label:'الأهداف والحوافز',href:`${base}/incentives`}
    ]},
    {label:'الإدارة والمحتوى',items:[
      {key:'settings',label:'الإعدادات والصلاحيات',href:`${base}/settings`},
      {key:'news',label:'الأخبار والمعارف',href:`${base}/news`}
    ]}
  ];
}

const platformGroups=[
  {label:'إدارة المنصة',items:[
    {key:'overview',label:'لوحة المنصة',href:'/control'},
    {key:'tenants',label:'المنشآت',href:'/control/tenants'},
    {key:'subscriptions',label:'الباقات والاشتراكات',href:'/control/subscriptions'},
    {key:'content',label:'المحتوى والمعارف',href:'/control/content'},
    {key:'settings',label:'إعدادات المنصة',href:'/control/settings'}
  ]}
];

function isActive(pathname,href){
  if(href==='/control')return pathname===href;
  if(/^\/tenant\/[^/]+$/.test(href))return pathname===href;
  return pathname===href||pathname.startsWith(`${href}/`);
}

export default function WorkspaceShell({kind,slug,title,email,children}){
  const pathname=usePathname();
  const [mobileOpen,setMobileOpen]=useState(false);
  const groups=useMemo(()=>{
    if(kind===WORKSPACE_KINDS.tenant)return tenantGroups(slug);
    return platformGroups;
  },[kind,slug]);
  const areaLabel=kind===WORKSPACE_KINDS.tenant?'لوحة المنشأة':'لوحة إدارة المنصة';

  return <div className={`mt-workspace mt-workspace-${kind}`}>
    {mobileOpen&&<button className="mt-shell-backdrop" aria-label="إغلاق القائمة" onClick={()=>setMobileOpen(false)}/>}
    <aside className={`mt-sidebar ${mobileOpen?'is-open':''}`}>
      <div className="mt-sidebar-brand">
        <MarktoneLogo subtitle={areaLabel}/>
        <button className="mt-sidebar-close" onClick={()=>setMobileOpen(false)} aria-label="إغلاق القائمة">×</button>
      </div>
      <div className="mt-context-card">
        <span>{kind===WORKSPACE_KINDS.tenant?'منشأة نشطة':'إدارة SaaS المركزية'}</span>
        <b>{title}</b>
        <small>{areaLabel}</small>
      </div>
      <nav className="mt-navigation" aria-label="القائمة الرئيسية">
        {groups.map(group=><section key={group.label}>
          <h2>{group.label}</h2>
          {group.items.map(item=><Link
            key={item.href}
            href={item.href}
            className={isActive(pathname,item.href)?'active':''}
            onClick={()=>setMobileOpen(false)}
          >
            <span aria-hidden="true">{icons[item.key]||'•'}</span>
            <b>{item.label}</b>
          </Link>)}
        </section>)}
      </nav>
      <div className="mt-sidebar-footer">
        <div><span>{email?.[0]?.toUpperCase()||'م'}</span><p><b>{email?.split('@')[0]||'مستخدم ماركتون'}</b><small>{email}</small></p></div>
        <LogoutButton/>
      </div>
    </aside>

    <div className="mt-main">
      <header className="mt-topbar">
        <button className="mt-menu-toggle" onClick={()=>setMobileOpen(true)} aria-label="فتح القائمة">☰</button>
        <div><small>{areaLabel}</small><h1>{title}</h1></div>
        <div className="mt-top-actions">
          {kind===WORKSPACE_KINDS.tenant&&<Link className="mt-quick-link" href={`/tenant/${encodeURIComponent(slug)}/tasks`}>+ مهمة جديدة</Link>}
          {kind===WORKSPACE_KINDS.platform&&<Link className="mt-quick-link" href="/control/tenants">إدارة المنشآت</Link>}
          <span className="mt-live-dot">متصل</span>
        </div>
      </header>
      <main className="mt-content">{children}</main>
    </div>
  </div>;
}
