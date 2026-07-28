'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useMemo,useState} from 'react';
import LogoutButton from './logout-button';
import MarktoneLogo from './marktone-logo';
import {WORKSPACE_KINDS} from '../lib/workspaces';

const icons={
  overview:'⌂',tenants:'▦',subscriptions:'◫',content:'▤',settings:'⚙',
  tasks:'✓',sales:'↗',leadQueue:'⇄',admissions:'⌁',incentives:'◎',people:'♙',courses:'▤',news:'◧'
};

function tenantGroups(slug,permissions,platformAccess){
  const base=`/tenant/${encodeURIComponent(slug)}`;
  const groups=[
    {label:'التشغيل اليومي',items:[
      {key:'overview',label:'لوحة المنشأة',href:base,permission:'tenant.workspace.read'},
      {key:'tasks',label:'المهام والتقويم',href:`${base}/tasks`,permission:'tenant.work.read'},
      {key:'sales',label:'المبيعات والعملاء',href:`${base}/sales`,permission:'tenant.crm.read'},
      {key:'leadQueue',label:'استقبال وتوزيع العملاء',href:`${base}/lead-queue`,permission:'tenant.leads.read'},
      {key:'admissions',label:'التسجيل والقبول',href:`${base}/admissions`,permission:'tenant.admissions.read'},
      {key:'incentives',label:'الأهداف والحوافز',href:`${base}/incentives`,permission:'tenant.incentives.read'}
    ]},
    {label:'الإدارة والمحتوى',items:[
      {key:'people',label:'فريق العمل',href:`${base}/team`,permission:'tenant.people.read'},
      {key:'courses',label:'الدورات والبرامج',href:`${base}/courses`,permission:'tenant.academy.read'},
      {key:'settings',label:'الإعدادات والصلاحيات',href:`${base}/settings`,permission:'tenant.users.manage'},
      {key:'news',label:'الأخبار والمعارف',href:`${base}/news`,permission:'tenant.content.read'}
    ]}
  ];
  const allowed=new Set(permissions||[]);
  return groups.map(group=>({
    ...group,
    items:group.items.filter(item=>platformAccess||allowed.has(item.permission))
  })).filter(group=>group.items.length);
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

export default function WorkspaceShell({
  kind,
  slug,
  title,
  email,
  children,
  permissions=[],
  platformAccess=false,
  roleLabel=''
}){
  const pathname=usePathname();
  const [mobileOpen,setMobileOpen]=useState(false);
  const groups=useMemo(()=>{
    if(kind===WORKSPACE_KINDS.tenant)return tenantGroups(
      slug,
      permissions,
      platformAccess
    );
    return platformGroups;
  },[kind,slug,permissions,platformAccess]);
  const areaLabel=kind===WORKSPACE_KINDS.tenant?'لوحة المنشأة':'لوحة إدارة المنصة';
  const canCreateTask=platformAccess||permissions.includes('tenant.work.write');

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
        <div><span>{email?.[0]?.toUpperCase()||'م'}</span><p><b>{email?.split('@')[0]||'مستخدم ماركتون'}</b><small>{roleLabel||email}</small></p></div>
        <LogoutButton/>
      </div>
    </aside>

    <div className="mt-main">
      <header className="mt-topbar">
        <button className="mt-menu-toggle" onClick={()=>setMobileOpen(true)} aria-label="فتح القائمة">☰</button>
        <div><small>{areaLabel}</small><h1>{title}</h1></div>
        <div className="mt-top-actions">
          {kind===WORKSPACE_KINDS.tenant&&canCreateTask&&<Link className="mt-quick-link" href={`/tenant/${encodeURIComponent(slug)}/tasks`}>+ مهمة جديدة</Link>}
          {kind===WORKSPACE_KINDS.platform&&<Link className="mt-quick-link" href="/control/tenants">إدارة المنشآت</Link>}
          <span className="mt-live-dot">متصل</span>
        </div>
      </header>
      <main className="mt-content">{children}</main>
    </div>
  </div>;
}
