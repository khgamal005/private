import Link from 'next/link';
import {getPlatformControl} from '../../lib/platform-api';

export const dynamic='force-dynamic';

const number=value=>new Intl.NumberFormat('ar-SA').format(Number(value)||0);
const date=value=>value?new Date(value).toLocaleString('ar-SA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';

const AREAS=[
  {capability:'tenants',title:'إدارة المنشآت',description:'إنشاء المنشآت وتحديث حالتها ومتابعة التشغيل.',href:'/control/tenants',icon:'▦'},
  {capability:'billing',title:'الباقات وحدود الاستخدام',description:'تسعير الباقات وتحديد حدود الموظفين والطلاب والدورات والعملاء.',href:'/control/plans',icon:'▤'},
  {capability:'billing',title:'متجر الإضافات',description:'أقسام الإضافات والأسعار المؤرخة والتراخيص الخاصة بكل منشأة.',href:'/control/addons',icon:'⊞'},
  {capability:'billing',title:'متجر الخدمات',description:'أقسام الخدمات وأسعارها وطلبات التنفيذ البشري.',href:'/control/services',icon:'▣'},
  {capability:'billing',title:'اشتراكات المنشآت',description:'دورة حياة الاشتراكات والتجارب والتجديد والإيقاف.',href:'/control/subscriptions',icon:'◫'},
  {capability:'billing',title:'المدفوعات والتحصيل',description:'العمليات المالية والطلبات غير المحصلة والتحقق من الدفع.',href:'/control/payments',icon:'◉'},
  {capability:'content',title:'المحتوى والمعارف',description:'تحرير الأخبار والمعارف وإدارة مصادر المحتوى.',href:'/control/content',icon:'✦'},
  {capability:'website',title:'الموقع الإلكتروني',description:'إدارة صفحات ماركتون والمقالات والقوائم والبيلدر.',href:'/control/website',icon:'◇'},
  {capability:'access',title:'فريق المنصة والصلاحيات',description:'إضافة الموظفين وبناء الأدوار وتحديد الصلاحيات.',href:'/control/team',icon:'♙'},
  {capability:'settings',title:'إعدادات المنصة',description:'إدارة التكاملات والإعدادات المركزية.',href:'/control/settings',icon:'⚙'}
];

export default async function ControlOverview({searchParams}){
  const params=await searchParams;
  const data=await getPlatformControl();
  const summary=data.summary||{};
  const capabilities=data.capabilities||{};
  const areas=AREAS.filter(area=>capabilities[area.capability]);
  const overdue=(data.tenants||[]).reduce((sum,tenant)=>sum+Number(tenant.overdueTasks||0),0);
  const primaryArea=areas[0];

  return <>
    <header className="mt-page-head">
      <div>
        <small>PLATFORM CONTROL</small>
        <h2>لوحة إدارة منصة مُدار</h2>
        <p>مركز SaaS موحد لإدارة المنشآت والمنتجات والباقات والاشتراكات والتحصيل.</p>
      </div>
      {primaryArea&&<div className="mt-page-actions"><Link className="mt-button primary" href={primaryArea.href}>فتح {primaryArea.title}</Link></div>}
    </header>

    {params?.reason==='forbidden'&&<div className="mt-alert error">هذه الشاشة ليست ضمن صلاحيات دورك. تم إعادتك إلى لوحة المنصة.</div>}

    <section className="mt-grid">
      {areas.map(area=><Link className="mt-panel" href={area.href} key={area.href} style={{textDecoration:'none',color:'inherit'}}>
        <div className="mt-panel-body" style={{display:'grid',gridTemplateColumns:'52px 1fr',gap:'16px',alignItems:'center'}}>
          <span style={{width:'52px',height:'52px',borderRadius:'15px',display:'grid',placeItems:'center',background:'#eef4f8',color:'#0b3155',fontSize:'23px'}}>{area.icon}</span>
          <div><h3 style={{margin:'0 0 7px'}}>{area.title}</h3><p style={{margin:0,color:'#6f8090',lineHeight:1.7}}>{area.description}</p></div>
        </div>
      </Link>)}
    </section>

    {(capabilities.tenants||capabilities.settings)&&<section className="mt-kpis">
      {capabilities.tenants&&<>
        <article className="mt-kpi"><span>إجمالي المنشآت</span><b>{number(summary.organizations)}</b><small>{number(summary.activeTenants)} منشأة نشطة</small></article>
        <article className={`mt-kpi ${overdue?'danger':''}`}><span>مهام متأخرة بالمنشآت</span><b>{number(overdue)}</b><small>مؤشر صحة التشغيل</small></article>
      </>}
      {capabilities.settings&&<>
        <article className="mt-kpi"><span>التكاملات النشطة</span><b>{number(summary.integrations)}</b><small>اتصالات المنصة والمنشآت</small></article>
        <article className={`mt-kpi ${summary.openSupport?'warning':''}`}><span>طلبات الدعم</span><b>{number(summary.openSupport)}</b><small>طلبات تحتاج مراجعة بشرية</small></article>
      </>}
    </section>}

    {capabilities.billing&&<section className="mt-kpis">
      <article className="mt-kpi"><span>الاشتراكات النشطة</span><b>{number(data.commerce?.summary?.activeSubscriptions)}</b><small>{number(data.commerce?.summary?.trialSubscriptions)} اشتراك تجريبي</small></article>
      <article className="mt-kpi"><span>الإيراد الشهري المتكرر</span><b>{new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:0}).format((Number(data.commerce?.summary?.monthlyRecurringMinor)||0)/100)}</b><small>من الاشتراكات النشطة</small></article>
      <article className={`mt-kpi ${data.commerce?.summary?.pendingPayments?'warning':''}`}><span>طلبات تنتظر الدفع</span><b>{number(data.commerce?.summary?.pendingPayments)}</b><small>إضافات وخدمات غير محصلة</small></article>
      <article className={`mt-kpi ${data.commerce?.summary?.pastDueSubscriptions?'danger':''}`}><span>اشتراكات متأخرة</span><b>{number(data.commerce?.summary?.pastDueSubscriptions)}</b><small>تحتاج متابعة تحصيل</small></article>
    </section>}

    {(capabilities.tenants||capabilities.audit)&&<section className="mt-grid">
      {capabilities.tenants&&<article className="mt-panel">
        <header className="mt-panel-head"><div><h3>آخر المنشآت</h3><p>الحالة والباقة ومؤشرات التشغيل</p></div><Link className="mt-button soft" href="/control/tenants">عرض الكل</Link></header>
        <div className="mt-panel-body mt-list">{(data.tenants||[]).slice(0,7).map(tenant=><div className="mt-list-row" key={tenant.id}>
          <div><b>{tenant.name}</b><small>{tenant.slug} · {tenant.employees||0} موظفين · {tenant.services||0} خدمات</small></div>
          <span className={`mt-status ${tenant.status}`}>{tenant.status==='active'?'نشطة':tenant.status==='trial'?'تجريبية':tenant.status}</span>
        </div>)}{!(data.tenants||[]).length&&<div className="mt-empty">لا توجد منشآت مسجلة.</div>}</div>
      </article>}
      {capabilities.audit&&<article className="mt-panel">
        <header className="mt-panel-head"><div><h3>آخر العمليات</h3><p>سجل التنفيذ على المنصة</p></div></header>
        <div className="mt-panel-body mt-list">{(data.audit||[]).slice(0,7).map(item=><div className="mt-list-row" key={item.id}>
          <div><b>{item.action} · {item.resourceType}</b><small>{item.actorEmail||item.actorName||'النظام'} · {item.tenantName||'المنصة'}</small></div><em>{date(item.occurredAt)}</em>
        </div>)}{!(data.audit||[]).length&&<div className="mt-empty">لا توجد عمليات حديثة.</div>}</div>
      </article>}
    </section>}
  </>;
}
