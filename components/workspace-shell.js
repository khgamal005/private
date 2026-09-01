'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import {usePathname} from 'next/navigation';
import {useMemo,useState} from 'react';
import LogoutButton from './logout-button';
import MarktoneLogo from './marktone-logo';
import NotificationCenter from './notification-center';
import {WORKSPACE_KINDS} from '../lib/workspaces';
import {tenantRolePolicy} from '../lib/tenant-role-policy';

const OdeiryAssistant=dynamic(()=>import('./odeiry-assistant'),{ssr:false});

const ICON_PATHS={
  overview:['M3 10.8 12 3l9 7.8','M5.5 9.4V21h13V9.4','M9 21v-6h6v6'],
  tenants:['M4 21V8l8-5 8 5v13','M9 21v-5h6v5','M8 10h.01M12 10h.01M16 10h.01'],
  registrations:['M5 4h14v16H5z','M8 8h8M8 12h5','m15 17 2 2 4-5'],
  subscriptions:['M4 6h16v12H4z','M4 10h16','M8 15h3'],
  plans:['M4 6h16v12H4z','M4 10h16','M8 15h3'],
  catalog:['M4 8h16l-1 13H5L4 8Z','M7 8V6a5 5 0 0 1 10 0v2'],
  billing:['M3 6h18v12H3z','M3 10h18','M7 15h4'],
  payments:['M3 6h18v12H3z','M3 10h18','M7 15h4'],
  providers:['M12 3v4M12 17v4M3 12h4M17 12h4','M8.5 8.5h7v7h-7z'],
  services:['M4 7h16v13H4z','M8 7V4h8v3','M8 12h8M8 16h5'],
  marketplace:['M4 8h16l-1 13H5L4 8Z','M7 8V6a5 5 0 0 1 10 0v2','M8 12h.01M16 12h.01'],
  servicesStore:['M4 7h16v13H4z','M8 7V4h8v3','M8 12h8M8 16h5'],
  addonsStore:['M12 3v4M12 17v4M3 12h4M17 12h4','M8.5 8.5h7v7h-7z'],
  addons:['M12 3v4M12 17v4M3 12h4M17 12h4','M8.5 8.5h7v7h-7z'],
  content:['M5 4h14v16H5z','M8 8h8M8 12h8M8 16h5'],
  website:['M3 5h18v14H3z','M3 9h18','M7 7h.01M10 7h.01','M7 13h4M7 16h8'],
  settings:['M4 7h10M18 7h2M4 17h2M10 17h10','M14 4v6M6 14v6'],
  integrations:['M8 12h8','M6 8a4 4 0 0 1 4-4h2','M18 16a4 4 0 0 1-4 4h-2','M8 8 5 8M16 16l-5-8'],
  tasks:['M5 4h14v16H5z','m8 14 2 2 4-5'],
  sales:['M4 18 9 13l4 3 7-9','M15 7h5v5'],
  callReports:['M7.3 3.8 10 8.4 7.7 10c1.2 2.7 3.5 5 6.2 6.2l1.6-2.3 4.7 2.7-.7 3.2c-.2.9-1 1.5-1.9 1.5C10.4 19.5 4.5 13.6 4.5 6.3c0-.9.6-1.7 1.5-1.9z'],
  yeastar:['M7.3 3.8 10 8.4 7.7 10c1.2 2.7 3.5 5 6.2 6.2l1.6-2.3 4.7 2.7-.7 3.2c-.2.9-1 1.5-1.9 1.5C10.4 19.5 4.5 13.6 4.5 6.3c0-.9.6-1.7 1.5-1.9z','M15 4h5v5'],
  reports:['M4 19V9M10 19V5M16 19v-7M22 19V3','M2 21h22'],
  campaignReports:['M4 11v2M7 8l10-4v16L7 16z','M7 16v4h4v-3'],
  leadQueue:['M4 8h13','m14 5 3 3-3 3','M20 16H7','m10 13-3 3 3 3'],
  admissions:['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M3 21v-2a6 6 0 0 1 6-6h2','m15 17 2 2 4-5'],
  incentives:['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z','M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M12 12h.01'],
  people:['M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M2 21v-2a6 6 0 0 1 6-6 6 6 0 0 1 6 6v2','M17 11a3 3 0 0 0 0-6M16 14a5 5 0 0 1 6 5v2'],
  courses:['M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z','M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z'],
  news:['M4 5h16v14H4z','M7 9h4v4H7zM14 9h3M14 12h3M7 16h10'],
  marketing:['M4 11v2M7 8l10-4v16L7 16z','M7 16v4h4v-3'],
  automation:['M12 3v3M12 18v3M3 12h3M18 12h3','m5.6 5.6 2.1 2.1m8.6 8.6 2.1 2.1m0-10.7-2.1 2.1M7.7 16.3l-2.1 2.1','M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
  accounting:['M5 3h14v18l-3-2-4 2-4-2-3 2z','M8 8h8M8 12h8M8 16h5'],
  support:['M4 5h16v12H9l-5 4z','M8 9h8M8 13h5'],
  interactive:['M4 5h16v12H4z','m10 9 4 2.5-4 2.5z','M9 21h6'],
  search:['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z','m21 21-4.35-4.35'],
  notifications:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9','M10 21h4'],
  bell:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9','M10 21h4'],
  chevron:['m9 18 6-6-6-6']
};

function ShellIcon({name}){
  const paths=ICON_PATHS[name]||ICON_PATHS.overview;
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {paths.map(path=><path key={path} d={path}/>)}
  </svg>;
}

function tenantItems(
  slug,
  permissions,
  platformAccess,
  roleKey,
  yeastarAccess,
  addonAccess,
  supportSummary
){
  const base=`/tenant/${encodeURIComponent(slug)}`;
  const policy=tenantRolePolicy(roleKey,{platformAccess});
  const enabledAddons=new Set(addonAccess?.enabledProductKeys||[]);
  const hasAddon=productKey=>enabledAddons.has(productKey);
  const hasAnyAddon=productKeys=>productKeys.some(hasAddon);
  const items=[
    {key:'overview',label:'لوحة القيادة',href:base,permission:'tenant.workspace.read'},
    {key:'news',label:'الأخبار والمعارف',href:`${base}/news`,permission:'tenant.content.read',visible:policy.showNews},
    {key:'tasks',label:'تقويم المهام',href:`${base}/tasks`,permission:'tenant.work.read'},
    {key:'courses',label:'الدبلومات والدورات',href:`${base}/courses`,permission:'tenant.academy.read'},
    {key:'interactive',label:'منصة التدريب التفاعلي',href:`${base}/lms`,permission:'tenant.academy.read',visible:policy.showInteractiveTraining&&hasAddon('lms')},
    {key:'sales',label:'المبيعات والعملاء',children:[
      {key:'search',label:'البحث عن عميل',href:`${base}/customer-search`,always:true},
      {key:'sales',label:'إدارة المبيعات والعملاء',href:`${base}/sales`,permission:'tenant.crm.read'},
      {key:'leadQueue',label:'توزيع العملاء',href:`${base}/lead-queue`,permission:'tenant.leads.read'}
    ]},
    {key:'admissions',label:'التسجيل والقبول',href:`${base}/admissions`,permission:'tenant.admissions.read'},
    {key:'yeastar',label:'إضافة Yeastar',visible:Boolean(
      yeastarAccess?.enabled&&yeastarAccess?.visible
    ),children:[
      {key:'callReports',label:'تقارير المكالمات',href:`${base}/yeastar`,permission:'tenant.crm.read',visible:Boolean(yeastarAccess?.canView)},
      {key:'settings',label:'إعدادات الربط',href:`${base}/yeastar/settings`,permission:'tenant.settings.manage',visible:Boolean(yeastarAccess?.canManage)}
    ]},
    {key:'marketing',label:'التسويق والأتمتة',visible:policy.showMarketingAutomation&&hasAnyAddon(['marketing_attribution','automation']),children:[
      {key:'marketing',label:'مركز الحملات والتسويق',href:`${base}/marketing`,permission:'tenant.marketing.read',visible:hasAddon('marketing_attribution')},
      {key:'automation',label:'الأتمتة',href:`${base}/settings?tab=automation`,permission:'tenant.users.manage',visible:hasAddon('automation')}
    ]},
    {key:'accounting',label:'الحسابات والفوترة',children:[
      {key:'overview',label:'لوحة الحسابات',href:`${base}/accounting`,permission:'tenant.accounting.read'},
      {key:'people',label:'حسابات العملاء والمستحقات',href:`${base}/accounting/receivables`,permission:'tenant.accounting.read'},
      {key:'sales',label:'عروض الأسعار',href:`${base}/accounting/quotes`,permission:'tenant.accounting.read'},
      {key:'accounting',label:'الفواتير',href:`${base}/accounting/invoices`,permission:'tenant.accounting.read'},
      {key:'payments',label:'المدفوعات والإيصالات',href:`${base}/accounting/payments`,permission:'tenant.accounting.read'},
      {key:'billing',label:'المرتجعات والتسويات',href:`${base}/accounting/adjustments`,permission:'tenant.accounting.read'},
      {key:'incentives',label:'الحوافز والعمولات',href:`${base}/accounting/incentives`,permission:['tenant.accounting.read','tenant.incentives.read']},
      {key:'reports',label:'التقارير المالية',href:`${base}/accounting/reports`,permission:'tenant.accounting.read'},
      {key:'settings',label:'إعدادات الحسابات',href:`${base}/accounting/settings`,permission:['tenant.accounting.settings.manage','tenant.accounting.read']},
      {key:'integrations',label:'زاتكا والفوترة الإلكترونية',href:`${base}/accounting/zatca`,permission:['tenant.zatca.manage','tenant.accounting.read'],visible:hasAddon('zatca')}
    ]},
    {key:'marketplace',label:'إضافات أودير',children:[
      {key:'addons',label:'الإضافات المثبتة',href:`${base}/addons`,permission:'tenant.settings.manage'},
      {key:'addonsStore',label:'إضافة جديدة',href:`${base}/addons-store`,permission:'tenant.settings.manage'}
    ]},
    {key:'servicesStore',label:'متجر الخدمات',href:`${base}/services-store`,permission:'tenant.settings.manage'},
    {key:'people',label:'فريق العمل',href:`${base}/team`,permission:'tenant.people.read',visible:policy.showTeam},
    {key:'reports',label:'التقارير والتحليل',children:[
      {key:'overview',label:'لوحة التقارير',href:`${base}/reports`,permission:'tenant.workspace.read'},
      {key:'people',label:policy.personalReportsOnly?'أدائي':'أداء الموظفين',href:`${base}/reports/employees`,permission:'tenant.workspace.read'},
      {key:'sales',label:'تقارير المبيعات',href:`${base}/reports/sales`,permission:'tenant.crm.read'},
      {key:'campaignReports',label:'تقارير الحملات',href:`${base}/reports/campaigns`,permission:['tenant.crm.read','tenant.leads.read','tenant.leads.analytics'],visible:policy.showCampaignReports}
    ]},
    {key:'website',label:'الموقع الإلكتروني',href:`${base}/website`,permission:'tenant.website.read',visible:hasAddon('cms_pro')},
    {key:'settings',label:'الإعدادات والصلاحيات',href:`${base}/settings`,permission:'tenant.users.manage'},
    {key:'integrations',label:'المزامنة والترابط',href:`${base}/integrations`,permission:'tenant.users.manage',visible:hasAnyAddon(['woocommerce','salla','zid','shopify','custom_store'])},
    {key:'support',label:'الدعم الفني',href:`${base}/support`,always:true,
      badge:tenantSupportAttentionCount(supportSummary),
      badgeLabel:'تذاكر دعم تحتاج متابعة'}
  ];
  const allowed=new Set(permissions||[]);
  const canUse=permission=>{
    if(platformAccess)return true;
    const required=Array.isArray(permission)?permission:[permission];
    return required.some(key=>allowed.has(key));
  };
  return items
    .map(item=>item.children?{...item,children:item.children.filter(child=>child.visible!==false&&(child.always||canUse(child.permission)))}:item)
    .filter(item=>item.visible!==false&&(item.always||item.children?.length||canUse(item.permission)));
}

function platformItems(permissions,registrationSummary,supportSummary){
  const allowed=new Set(permissions||[]);
  const items=[
    {key:'overview',label:'لوحة المنصة',href:'/control',permission:'platform.control.read'},
    {key:'notifications',label:'مركز الإشعارات',href:'/control/notifications',permission:[
      'platform.billing.manage','platform.tenants.manage',
      'platform.settings.manage','platform.control.write'
    ]},
    {key:'tenants',label:'المنشآت',href:'/control/tenants',permission:'platform.tenants.manage'},
    {key:'registrations',label:'طلبات التسجيل',href:'/control/registration-requests',permission:'platform.tenants.manage',badge:registrationAttentionCount(registrationSummary),badgeLabel:'طلبات تسجيل تحتاج متابعة'},
    {key:'catalog',label:'المنتجات والمتاجر',children:[
      {key:'plans',label:'الباقات وحدود الاستخدام',href:'/control/plans',permission:'platform.billing.manage'},
      {key:'addons',label:'متجر الإضافات',href:'/control/addons',permission:'platform.billing.manage'},
      {key:'services',label:'متجر الخدمات',href:'/control/services',permission:'platform.billing.manage'}
    ]},
    {key:'billing',label:'الاشتراكات والتحصيل',children:[
      {key:'subscriptions',label:'اشتراكات المنشآت',href:'/control/subscriptions',permission:'platform.billing.manage'},
      {key:'payments',label:'المدفوعات والتحصيل',href:'/control/payments',permission:'platform.billing.manage'},
      {key:'providers',label:'وسائل الدفع',href:'/control/payment-providers',permission:'platform.billing.manage'},
      {key:'marketplace',label:'كل طلبات المتجر',href:'/control/marketplace',permission:'platform.billing.manage'}
    ]},
    {key:'content',label:'المحتوى والمعارف',href:'/control/content',permission:'platform.content.manage'},
    {key:'website',label:'إدارة الموقع',href:'/control/website',permission:'platform.website.manage'},
    {key:'people',label:'فريق المنصة والصلاحيات',href:'/control/team',permission:'platform.access.manage'},
    {key:'settings',label:'إعدادات المنصة',href:'/control/settings',permission:['platform.settings.manage','platform.control.write']},
    {key:'support',label:'الدعم الفني',href:'/control/support',permission:[
      'platform.support.read','platform.support.reply','platform.support.manage'
    ],badge:platformSupportAttentionCount(supportSummary),badgeLabel:'تذاكر دعم تحتاج متابعة'}
  ];
  const canUse=permission=>{
    const required=Array.isArray(permission)?permission:[permission];
    return required.some(key=>allowed.has(key));
  };
  return items
    .map(item=>item.children?{...item,children:item.children.filter(child=>canUse(child.permission))}:item)
    .filter(item=>item.children?.length||canUse(item.permission));
}

function isActive(pathname,href){
  if(href==='/control')return pathname===href;
  if(/^\/tenant\/[^/]+$/.test(href))return pathname===href;
  if(/\/yeastar$/.test(href))return pathname===href;
  if(/\/accounting$/.test(href))return pathname===href;
  return pathname===href||pathname.startsWith(`${href}/`);
}
function count(value){return Math.max(0,Number(value)||0);}
function registrationAttentionCount(summary){
  return count(summary?.pendingReview)+count(summary?.underReview)+count(summary?.trustPending);
}
function tenantSupportAttentionCount(summary){
  return count(summary?.unread)+count(summary?.waitingTenant);
}
function platformSupportAttentionCount(summary){
  return count(summary?.unassigned)+count(summary?.overdue);
}
function notificationItems(summary,slug){
  const base=`/tenant/${encodeURIComponent(slug)}`;
  const items=[];
  const overdue=count(summary?.overdueTasks),today=count(summary?.tasksToday),admissions=count(summary?.pendingAdmissions),leads=count(summary?.activeLeads);
  if(overdue)items.push({tone:'danger',title:`${overdue} مهمة متأخرة`,description:'تحتاج إغلاقًا أو إعادة جدولة الآن.',href:`${base}/tasks`});
  if(today)items.push({tone:'blue',title:`${today} مهمة مطلوبة اليوم`,description:`من أصل ${count(summary?.openTasks)} مهمة مفتوحة.`,href:`${base}/tasks`});
  if(admissions)items.push({tone:'amber',title:`${admissions} طلب قبول معلّق`,description:'بانتظار المراجعة أو استكمال الإجراء.',href:`${base}/admissions`});
  if(leads)items.push({tone:'green',title:`${leads} عميل قيد المتابعة`,description:`تم تسجيل ${count(summary?.activitiesToday)} نشاط اليوم.`,href:`${base}/sales`});
  return items;
}

function tenantSupportNotificationItems(summary,slug){
  const unread=count(summary?.unread);
  const waiting=count(summary?.waitingTenant);
  if(!unread&&!waiting)return [];
  const title=unread&&waiting
    ?`${unread} رد جديد و${waiting} تذكرة تنتظر متابعتك`
    :unread?`${unread} رد جديد من دعم ماركتون`:`${waiting} تذكرة دعم تنتظر ردك`;
  return [{
    tone:waiting?'amber':'blue',
    title,
    description:'افتح الدعم الفني لمتابعة التذاكر دون عرض تفاصيلها هنا.',
    href:`/tenant/${encodeURIComponent(slug)}/support`
  }];
}

function platformNotificationItems(summary){
  const attention=registrationAttentionCount(summary);
  if(!attention)return [];
  return [{
    tone:'amber',
    title:`${attention} طلب تسجيل يحتاج متابعة`,
    description:'راجع طلبات المنشآت واتخذ الإجراء المناسب.',
    href:'/control/registration-requests'
  }];
}

function platformSupportNotificationItems(summary){
  const unassigned=count(summary?.unassigned);
  const overdue=count(summary?.overdue);
  if(!unassigned&&!overdue)return [];
  const title=unassigned&&overdue
    ?`${unassigned} تذكرة غير مسندة و${overdue} متأخرة`
    :unassigned?`${unassigned} تذكرة دعم غير مسندة`:`${overdue} تذكرة دعم متأخرة`;
  return [{
    tone:overdue?'danger':'amber',
    title,
    description:'راجع طابور الدعم وحدد أولوية المعالجة.',
    href:'/control/support'
  }];
}

function odeiryContext(pathname){
  const segments=String(pathname||'').split('/').filter(Boolean);
  if(segments[0]!=='tenant')return {module:'other',pathClass:'workspace.other'};
  const section=segments[2]||'';
  if(!section)return {module:'dashboard',pathClass:'workspace.dashboard'};
  if(section==='tasks')return {module:'tasks_calendar',pathClass:'workspace.tasks_calendar'};
  if(section==='courses'||section==='lms')return {module:'courses',pathClass:'workspace.courses'};
  if(['customer-search','sales','lead-queue'].includes(section)){
    return {module:'sales_crm',pathClass:'workspace.sales_crm'};
  }
  if(section==='admissions')return {module:'admissions',pathClass:'workspace.admissions'};
  if(section==='marketing'){
    return {module:'marketing_automation',pathClass:'workspace.marketing_automation'};
  }
  if(section==='accounting')return {module:'accounting',pathClass:'workspace.accounting'};
  if(['addons','addons-store','services-store'].includes(section)){
    return {module:'addons_marketplace',pathClass:'workspace.addons_marketplace'};
  }
  if(section==='team'||section==='settings'){
    return {module:'team_permissions',pathClass:'workspace.team_permissions'};
  }
  if(section==='reports')return {module:'reports',pathClass:'workspace.reports'};
  if(section==='website')return {module:'website',pathClass:'workspace.website'};
  if(section==='integrations'||section==='yeastar'){
    return {module:'integrations',pathClass:'workspace.integrations'};
  }
  if(section==='support')return {module:'support',pathClass:'workspace.support'};
  return {module:'other',pathClass:'workspace.other'};
}

export default function WorkspaceShell({kind,slug,title,email,userName='',children,permissions=[],platformAccess=false,roleKey='member',roleLabel='',notificationSummary=null,platformRegistrationSummary=null,supportSummary=null,yeastarAccess=null,addonAccess=null,odeiryEnabled=false,odeiryAccessMode=null,odeiryManagerEnabled=false,odeiryManagerReviewEnabled=false}){
  const pathname=usePathname();
  const [mobileOpen,setMobileOpen]=useState(false);
  const [openGroups,setOpenGroups]=useState(()=>({
    marketplace:pathname.includes('/addons'),
    sales:['/customer-search','/sales','/lead-queue'].some(path=>pathname.includes(path)),
    accounting:pathname.includes('/accounting')||pathname.includes('/incentives'),
    yeastar:pathname.includes('/yeastar')||pathname.includes('/call-reports'),
    marketing:pathname.includes('/marketing')||pathname.includes('/settings'),
    reports:pathname.includes('/reports'),
    catalog:['/plans','/addons','/services'].some(path=>pathname.includes(path)),
    billing:['/subscriptions','/payments','/payment-providers','/marketplace'].some(path=>pathname.includes(path))
  }));
  const items=useMemo(()=>kind===WORKSPACE_KINDS.tenant
    ?tenantItems(
      slug,
      permissions,
      platformAccess,
      roleKey,
      yeastarAccess,
      addonAccess,
      supportSummary
    )
    :platformItems(permissions,platformRegistrationSummary,supportSummary),[
      kind,
      slug,
      permissions,
      platformAccess,
      roleKey,
      yeastarAccess,
      addonAccess,
      platformRegistrationSummary,
      supportSummary
    ]);
  const areaLabel=kind===WORKSPACE_KINDS.tenant?'لوحة المنشأة':'لوحة إدارة المنصة';
  const canCreateTask=platformAccess||permissions.includes('tenant.work.write');
  const canSearch=kind===WORKSPACE_KINDS.tenant;
  const platformSettingsHref=permissions.includes('platform.settings.manage')||permissions.includes('platform.control.write')
    ?'/control/settings'
    :permissions.includes('platform.access.manage')
      ?'/control/team'
      :null;
  const canOpenSettings=kind===WORKSPACE_KINDS.tenant
    ?platformAccess||permissions.includes('tenant.users.manage')
    :Boolean(platformSettingsHref);
  const canManageTenants=permissions.includes('platform.tenants.manage');
  const canReadPlatformSupport=[
    'platform.support.read','platform.support.reply','platform.support.manage'
  ].some(permission=>permissions.includes(permission));
  const canOpenPlatformInbox=[
    'platform.billing.manage','platform.tenants.manage',
    'platform.settings.manage','platform.control.write'
  ].some(permission=>permissions.includes(permission));
  const profileName=userName||email?.split('@')[0]||'مستخدم ماركتون';
  const profileInitial=Array.from(profileName.trim())[0]||'م';
  const notifications=kind===WORKSPACE_KINDS.tenant?[
    ...notificationItems(notificationSummary,slug),
    ...tenantSupportNotificationItems(supportSummary,slug)
  ]:[];
  const platformNotifications=kind===WORKSPACE_KINDS.platform?[
    ...(canManageTenants?platformNotificationItems(platformRegistrationSummary):[]),
    ...(canReadPlatformSupport?platformSupportNotificationItems(supportSummary):[])
  ]:[];
  const operationalNotificationCount=count(notificationSummary?.overdueTasks)
    +count(notificationSummary?.tasksToday)
    +count(notificationSummary?.pendingAdmissions)
    +tenantSupportAttentionCount(supportSummary);
  const platformOperationalCount=(canManageTenants
    ?registrationAttentionCount(platformRegistrationSummary):0)
    +(canReadPlatformSupport?platformSupportAttentionCount(supportSummary):0);
  const assistantContext=useMemo(()=>odeiryContext(pathname),[pathname]);
  return <div className={`mt-workspace mt-workspace-${kind}`}>
    {mobileOpen&&<button className="mt-shell-backdrop" aria-label="إغلاق القائمة" onClick={()=>setMobileOpen(false)}/>} 
    <aside className={`mt-sidebar ${mobileOpen?'is-open':''}`}>
      <div className="mt-sidebar-brand"><MarktoneLogo wordmark compact/><button className="mt-sidebar-close" onClick={()=>setMobileOpen(false)} aria-label="إغلاق القائمة">×</button></div>
      <div className="mt-context-card"><span className="mt-context-status">{kind===WORKSPACE_KINDS.tenant?'منشأة نشطة':'إدارة SaaS المركزية'}</span><b>{title}</b></div>
      <nav className="mt-navigation" aria-label="القائمة الرئيسية">
        {items.map(item=>{
          if(!item.children)return <Link key={item.href||item.key} href={item.href||'#'} aria-disabled={item.disabled||undefined} tabIndex={item.disabled?-1:undefined} className={item.disabled?'disabled':isActive(pathname,item.href)?'active':''} style={item.disabled?{cursor:'default',opacity:.55}:undefined} onClick={event=>{if(item.disabled){event.preventDefault();return;}setMobileOpen(false);}}><span><ShellIcon name={item.key}/></span><b>{item.label}</b>{item.badge>0&&<em className="mt-navigation-badge" aria-label={`${item.badge} ${item.badgeLabel||'عناصر تحتاج متابعة'}`}>{item.badge>99?'99+':item.badge}</em>}</Link>;
          const childActive=item.children.some(child=>!child.disabled&&child.href&&isActive(pathname,child.href));
          const isOpen=Boolean(openGroups[item.key]);
          return <div className={`mt-navigation-group ${childActive?'active':''}`} key={item.key}>
            <button type="button" className="mt-navigation-parent" aria-expanded={isOpen} onClick={()=>setOpenGroups(current=>({...current,[item.key]:!current[item.key]}))}><span><ShellIcon name={item.key}/></span><b>{item.label}</b><i><ShellIcon name="chevron"/></i></button>
            {isOpen&&<div className="mt-navigation-children">{item.children.map(child=><Link key={child.href||`${item.key}-${child.key}`} href={child.href||'#'} aria-disabled={child.disabled||undefined} tabIndex={child.disabled?-1:undefined} className={child.disabled?'disabled':isActive(pathname,child.href)?'active':''} style={child.disabled?{cursor:'default',opacity:.55}:undefined} onClick={event=>{if(child.disabled){event.preventDefault();return;}setMobileOpen(false);}}><span><ShellIcon name={child.key}/></span><b>{child.label}</b></Link>)}</div>}
          </div>;
        })}
      </nav>
    </aside>
    <div className="mt-main">
      <header className="mt-topbar">
        <div className="mt-topbar-identity"><button className="mt-menu-toggle" onClick={()=>setMobileOpen(true)} aria-label="فتح القائمة"><span/><span/><span/></button><div><small>{areaLabel}</small><h1>{title}</h1></div></div>
        {canSearch&&<Link className="mt-global-search" href={`/tenant/${encodeURIComponent(slug)}/customer-search`}><ShellIcon name="search"/><span>ابحث برقم الجوال أو اسم العميل…</span></Link>}
        <div className="mt-topbar-tools">
          {kind===WORKSPACE_KINDS.tenant&&canCreateTask&&<Link className="mt-quick-link" href={`/tenant/${encodeURIComponent(slug)}/tasks`}>+ مهمة جديدة</Link>}
          {kind===WORKSPACE_KINDS.platform&&canManageTenants&&<Link className="mt-quick-link" href="/control/tenants">إدارة المنشآت</Link>}
          {kind===WORKSPACE_KINDS.platform&&(canOpenPlatformInbox||platformNotifications.length>0)&&<NotificationCenter
            scope="platform"
            className="mt-notification-menu"
            operationalItems={platformNotifications}
            operationalCount={platformOperationalCount}
            systemInboxEnabled={canOpenPlatformInbox}
            icon={<ShellIcon name="bell"/>}
            emptyMessage="لا توجد طلبات منصة أو أعطال تشغيلية تحتاج متابعة الآن."
            footerHref={canReadPlatformSupport?'/control/support':'/control/notifications'}
            footerLabel={canReadPlatformSupport?'فتح مركز الدعم':'فتح مركز الإشعارات'}
          />}
          {kind===WORKSPACE_KINDS.tenant&&<NotificationCenter
            slug={slug}
            className="mt-notification-menu"
            operationalItems={notifications}
            operationalCount={operationalNotificationCount}
            icon={<ShellIcon name="bell"/>}
            emptyMessage="لا توجد مهام أو تنبيهات عاجلة الآن."
          />}
          <details className="mt-toolbar-menu mt-account-menu"><summary><span className="mt-user-avatar">{profileInitial}</span><span className="mt-user-copy"><b>{profileName}</b><small>{roleLabel||email}</small></span><ShellIcon name="chevron"/></summary><div className="mt-account-popover"><header><span className="mt-user-avatar">{profileInitial}</span><div><b>{profileName}</b><small>{email}</small></div></header><p>{roleLabel||areaLabel}</p>{kind===WORKSPACE_KINDS.tenant&&platformAccess&&<Link href="/control">العودة إلى إدارة المنصة والمنشآت</Link>}{canOpenSettings&&<Link href={kind===WORKSPACE_KINDS.tenant?`/tenant/${encodeURIComponent(slug)}/settings`:platformSettingsHref}>إعدادات الحساب والصلاحيات</Link>}<LogoutButton/></div></details>
        </div>
      </header>
      <main className="mt-content">{children}</main>
    </div>
    {kind===WORKSPACE_KINDS.tenant&&odeiryEnabled&&<OdeiryAssistant
      key={slug}
      slug={slug}
      context={assistantContext}
      accessMode={odeiryAccessMode}
      managerEnabled={odeiryManagerEnabled&&!platformAccess}
      managerReviewEnabled={odeiryManagerReviewEnabled&&!platformAccess}
    />}
  </div>;
}

