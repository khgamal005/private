import Link from 'next/link';
import {getControl} from '../../lib/api';

export const dynamic='force-dynamic';

const number=value=>new Intl.NumberFormat('ar-SA').format(Number(value)||0);
const date=value=>value?new Date(value).toLocaleString('ar-SA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';

export default async function ControlOverview(){
  const data=await getControl();
  const summary=data.summary||{};
  const overdue=(data.tenants||[]).reduce((sum,tenant)=>sum+Number(tenant.overdueTasks||0),0);
  return <>
    <header className="mt-page-head">
      <div><small>PLATFORM CONTROL</small><h2>لوحة إدارة منصة ماركتون</h2><p>المنشآت والاشتراكات والمحتوى وحالة التشغيل من مركز واحد.</p></div>
      <div className="mt-page-actions"><Link className="mt-button primary" href="/control/tenants">إدارة المنشآت</Link></div>
    </header>
    <section className="mt-kpis">
      <article className="mt-kpi"><span>إجمالي المنشآت</span><b>{number(summary.organizations)}</b><small>{number(summary.activeTenants)} منشأة نشطة</small></article>
      <article className="mt-kpi"><span>التكاملات النشطة</span><b>{number(summary.integrations)}</b><small>اتصالات المنصة والمنشآت</small></article>
      <article className={`mt-kpi ${summary.openSupport?'warning':''}`}><span>طلبات الدعم</span><b>{number(summary.openSupport)}</b><small>طلبات تحتاج مراجعة بشرية</small></article>
      <article className={`mt-kpi ${overdue?'danger':''}`}><span>مهام متأخرة بالمنشآت</span><b>{number(overdue)}</b><small>مؤشر صحة التشغيل</small></article>
    </section>
    <section className="mt-grid">
      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>آخر المنشآت</h3><p>الحالة والباقة ومؤشرات التشغيل</p></div><Link className="mt-button soft" href="/control/tenants">عرض الكل</Link></header>
        <div className="mt-panel-body mt-list">{(data.tenants||[]).slice(0,7).map(tenant=><div className="mt-list-row" key={tenant.id}>
          <div><b>{tenant.name}</b><small>{tenant.slug} · {tenant.employees||0} موظفين · {tenant.services||0} خدمات</small></div>
          <span className={`mt-status ${tenant.status}`}>{tenant.status==='active'?'نشطة':tenant.status==='trial'?'تجريبية':tenant.status}</span>
        </div>)}{!(data.tenants||[]).length&&<div className="mt-empty">لا توجد منشآت مسجلة.</div>}</div>
      </article>
      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>آخر العمليات</h3><p>سجل التنفيذ على المنصة</p></div></header>
        <div className="mt-panel-body mt-list">{(data.audit||[]).slice(0,7).map(item=><div className="mt-list-row" key={item.id}>
          <div><b>{item.action} · {item.resourceType}</b><small>{item.actorEmail||item.actorName||'النظام'} · {item.tenantName||'المنصة'}</small></div><em>{date(item.occurredAt)}</em>
        </div>)}{!(data.audit||[]).length&&<div className="mt-empty">لا توجد عمليات حديثة.</div>}</div>
      </article>
    </section>
  </>;
}
