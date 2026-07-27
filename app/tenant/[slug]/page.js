import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTenant} from '../../../lib/api';
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',currency:'SAR',maximumFractionDigits:0
}).format((Number(value)||0)/100);
const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'
}):'غير محدد';

export default async function TenantOverview({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.workspace.read');
  const data=await getTenant(slug);
  if(!data)return notFound();
  const summary=data.summary||{};
  const openTasks=(data.tasks||[]).filter(task=>task.status!=='completed');
  const overdue=openTasks.filter(task=>new Date(task.dueAt)<new Date());
  const openOpportunities=(data.opportunities||[]).filter(item=>!item.closed);
  const stages=(data.stages||[]).filter(stage=>!stage.closed);

  return <>
    <header className="mt-page-head">
      <div><small>WORKSPACE OVERVIEW</small><h2>صباح الخير، فريق {data.tenant.name}</h2><p>نظرة موحدة على العمل المطلوب والمبيعات وأداء المنشأة.</p></div>
      <div className="mt-page-actions">
        <Link className="mt-button" href={`/tenant/${slug}/sales`}>فتح مسار المبيعات</Link>
        <Link className="mt-button primary" href={`/tenant/${slug}/tasks`}>إدارة مهام اليوم</Link>
      </div>
    </header>

    <section className="mt-kpis">
      <article className="mt-kpi"><span>قيمة مسار المبيعات</span><b>{money(summary.pipelineValueMinor)}</b><small>{summary.openOpportunities||openOpportunities.length} فرصة مفتوحة</small></article>
      <article className="mt-kpi"><span>المهام المفتوحة</span><b>{summary.openTasks||openTasks.length}</b><small>مهام فردية ومشتركة</small></article>
      <article className={`mt-kpi ${overdue.length?'danger':''}`}><span>المهام المتأخرة</span><b>{summary.overdueTasks||overdue.length}</b><small>تحتاج متابعة أو إعادة جدولة</small></article>
      <article className="mt-kpi"><span>العملاء النشطون</span><b>{data.contacts?.length||0}</b><small>{data.employees?.length||0} موظفًا داخل المنشأة</small></article>
      <article className="mt-kpi"><span>فريق العمل</span><b>{data.employees?.length||0}</b><small>{data.users?.length||0} حساب دخول مرتبط</small></article>
      <article className="mt-kpi"><span>الدورات النشطة</span><b>{data.services?.length||0}</b><small>الخطة الكاملة مفعّلة</small></article>
    </section>

    <section className="mt-grid">
      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>المهام الأقرب</h3><p>مرتبة حسب الموعد النهائي</p></div><Link className="mt-button soft" href={`/tenant/${slug}/tasks`}>عرض التقويم</Link></header>
        <div className="mt-panel-body mt-list">
          {openTasks.sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt)).slice(0,7).map(task=><div className="mt-list-row" key={task.id}>
            <div><b>{task.title}</b><small>{task.assigneeName||'غير مسند'} · {task.opportunityTitle||task.serviceName||'مهمة تشغيلية'}</small></div>
            <div><span className={new Date(task.dueAt)<new Date()?'mt-status danger':'mt-status'}>{when(task.dueAt)}</span></div>
          </div>)}
          {!openTasks.length&&<div className="mt-empty">لا توجد مهام مفتوحة حاليًا.</div>}
        </div>
      </article>

      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>حركة المبيعات</h3><p>توزيع الفرص على المراحل</p></div><Link className="mt-button soft" href={`/tenant/${slug}/sales`}>التفاصيل</Link></header>
        <div className="mt-panel-body mt-list">
          {stages.slice(0,6).map(stage=>{
            const items=openOpportunities.filter(item=>item.stageId===stage.id);
            const percent=openOpportunities.length?Math.round(items.length/openOpportunities.length*100):0;
            return <div className="mt-list-row" key={stage.id}><div><b>{stage.nameAr}</b><small>{items.length} فرصة</small><div className="mt-progress"><i style={{width:`${percent}%`}}/></div></div><em>{percent}%</em></div>;
          })}
          {!stages.length&&<div className="mt-empty">لم تُضبط مراحل المبيعات بعد.</div>}
        </div>
      </article>
    </section>

    <section className="mt-grid">
      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>فريق ريف المهارات</h3><p>الهيكل الأولي وحالة حسابات الدخول</p></div><Link className="mt-button soft" href={`/tenant/${slug}/team`}>إدارة الفريق</Link></header>
        <div className="mt-panel-body mt-list">
          {(data.employees||[]).slice(0,6).map(employee=><div className="mt-list-row" key={employee.id}>
            <div><b>{employee.name}</b><small>{employee.jobTitle||employee.role} · {employee.department}</small></div>
            <span className={employee.accountStatus==='active'?'mt-status active':'mt-status'}>{employee.accountStatus==='active'?'حساب نشط':'ملف وظيفي'}</span>
          </div>)}
          {!data.employees?.length&&<div className="mt-empty">لم يضف فريق العمل بعد.</div>}
        </div>
      </article>

      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>كتالوج الدورات</h3><p>البرامج الأساسية الجاهزة للتسعير والجدولة</p></div><Link className="mt-button soft" href={`/tenant/${slug}/courses`}>عرض الكتالوج</Link></header>
        <div className="mt-panel-body mt-list">
          {(data.services||[]).slice(0,6).map(course=><div className="mt-list-row" key={course.id}>
            <div><b>{course.nameAr}</b><small>{course.courseCode} · {course.durationHours?`${course.durationHours} ساعة`:'المدة تحدد لاحقًا'}</small></div>
            <span className="mt-status active">نشطة</span>
          </div>)}
          {!data.services?.length&&<div className="mt-empty">لم تضف دورات بعد.</div>}
        </div>
      </article>
    </section>
  </>;
}
