import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTenant,getTenantOperations} from '../../../lib/api';
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'
}):'غير محدد';
const SALES_GROUPS=[
  ['جديد',['new']],
  ['يحتاج متابعة',['no_answer','busy','follow_up','postponed']],
  ['مهتم',['interested']],
  ['مهتم جدًا',['very_interested']],
  ['بانتظار الدفع',['awaiting_payment']],
  ['تم الدفع',['paid']]
];
const ACTIVE_LEAD_STATUSES=new Set([
  'new','no_answer','busy','follow_up','interested',
  'very_interested','awaiting_payment','postponed'
]);

export default async function TenantOverview({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.workspace.read');
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const permissions=membership?.permissions||[];
  const canReadCrm=Boolean(
    context.platformAccess||permissions.includes('tenant.crm.read')
  );
  const canReadWork=Boolean(
    context.platformAccess||permissions.includes('tenant.work.read')
  );
  const [data,operations]=await Promise.all([
    getTenant(slug),
    getTenantOperations(slug,{includeSales:canReadCrm})
  ]);
  if(!data)return notFound();
  const summary=operations.summary||{};
  const openTasks=(operations.tasks||[]).filter(task=>
    ['todo','in_progress'].includes(task.status)
  );
  const overdue=openTasks.filter(task=>new Date(task.dueAt)<new Date());
  const contacts=operations.contacts||[];
  const activeLeads=contacts.filter(item=>ACTIVE_LEAD_STATUSES.has(item.leadStatus));
  const demoCount=(operations.contacts||[]).filter(item=>item.demo).length;

  return <>
    <header className="mt-page-head">
      <div><small>WORKSPACE OVERVIEW</small><h2>صباح الخير، فريق {data.tenant.name}</h2><p>نظرة موحدة على العمل المطلوب والمبيعات وأداء المنشأة.</p></div>
      <div className="mt-page-actions">
        {canReadCrm&&<Link className="mt-button" href={`/tenant/${slug}/sales`}>فتح مسار المبيعات</Link>}
        {canReadWork&&<Link className="mt-button primary" href={`/tenant/${slug}/tasks`}>إدارة مهام اليوم</Link>}
      </div>
    </header>

    {demoCount>0&&<section className="mt-data-note warning">
      <div>
        <b>أنت تشاهد دورة تشغيل تجريبية متكاملة</b>
        <p>{demoCount} عميلًا تجريبيًا مع فرص وأنشطة ومهام، مميّزون داخل قاعدة البيانات ولا يختلطون بالعملاء الحقيقيين.</p>
      </div>
      <span>بيانات تجريبية</span>
    </section>}

    <section className="mt-kpis">
      {canReadCrm&&<article className="mt-kpi"><span>العملاء داخل المسار</span><b>{summary.activeLeads||activeLeads.length}</b><small>{summary.awaitingPayment||0} بانتظار الدفع</small></article>}
      <article className="mt-kpi"><span>مهام اليوم</span><b>{summary.dueToday||0}</b><small>{openTasks.length} مهمة مفتوحة إجمالًا</small></article>
      <article className={`mt-kpi ${overdue.length?'danger':''}`}><span>المهام المتأخرة</span><b>{summary.overdueTasks||overdue.length}</b><small>تحتاج متابعة أو إعادة جدولة</small></article>
      {canReadCrm&&<article className="mt-kpi"><span>العملاء النشطون</span><b>{summary.activeContacts||0}</b><small>{summary.activitiesToday||0} نشاط اليوم</small></article>}
      <article className="mt-kpi"><span>فريق العمل</span><b>{data.employees?.length||0}</b><small>{data.users?.length||0} حساب دخول مرتبط</small></article>
      {canReadCrm&&<article className="mt-kpi"><span>تم الدفع هذا الشهر</span><b>{summary.paidThisMonth||0}</b><small>تم تسليمهم للتسجيل والقبول</small></article>}
      {!canReadCrm&&<article className="mt-kpi"><span>الدورات النشطة</span><b>{data.services?.length||0}</b><small>برامج متاحة داخل المنشأة</small></article>}
    </section>

    <section className="mt-grid">
      <article className="mt-panel">
        <header className="mt-panel-head"><div><h3>المهام الأقرب</h3><p>مرتبة حسب الموعد النهائي</p></div><Link className="mt-button soft" href={`/tenant/${slug}/tasks`}>عرض التقويم</Link></header>
        <div className="mt-panel-body mt-list">
          {openTasks.sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt)).slice(0,7).map(task=><div className="mt-list-row" key={task.id}>
            <div><b>{task.title}</b><small>{task.assigneeName||'غير مسند'} · {task.contactName||task.contactCourseName||'مهمة تشغيلية'}</small></div>
            <div><span className={new Date(task.dueAt)<new Date()?'mt-status danger':'mt-status'}>{when(task.dueAt)}</span></div>
          </div>)}
          {!openTasks.length&&<div className="mt-empty">لا توجد مهام مفتوحة حاليًا.</div>}
        </div>
      </article>

      {canReadCrm&&<article className="mt-panel">
        <header className="mt-panel-head"><div><h3>حركة المبيعات</h3><p>توزيع العملاء حسب نتيجة المتابعة</p></div><Link className="mt-button soft" href={`/tenant/${slug}/sales`}>التفاصيل</Link></header>
        <div className="mt-panel-body mt-list">
          {SALES_GROUPS.map(([label,statuses])=>{
            const items=contacts.filter(item=>statuses.includes(item.leadStatus));
            const percent=contacts.length?Math.round(items.length/contacts.length*100):0;
            return <div className="mt-list-row" key={label}><div><b>{label}</b><small>{items.length} عميل</small><div className="mt-progress"><i style={{width:`${percent}%`}}/></div></div><em>{percent}%</em></div>;
          })}
          {!contacts.length&&<div className="mt-empty">لم يضف عملاء إلى المسار بعد.</div>}
        </div>
      </article>}
    </section>

    {operations.viewer?.viewTeam&&<section className="mt-panel">
      <header className="mt-panel-head">
        <div><h3>متابعة فريق المبيعات</h3><p>العملاء النشطون والأنشطة والمهام المتأخرة لكل مسؤول</p></div>
        <Link className="mt-button soft" href={`/tenant/${slug}/sales`}>إدارة المسار</Link>
      </header>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>الموظف</th><th>عملاء قيد المتابعة</th><th>أنشطة اليوم</th><th>تم الدفع</th><th>مهام متأخرة</th></tr></thead>
        <tbody>{(operations.leaderboard||[]).map(item=><tr key={item.staffId}>
          <td><b>{item.name}</b><small>{item.roleKey==='sales_supervisor'?'مشرف المبيعات':'مسؤول مبيعات'}</small></td>
          <td>{item.openOpportunities}</td>
          <td>{item.activitiesToday}</td>
          <td><span className="mt-status active">{item.wonThisMonth}</span></td>
          <td><span className={item.overdueTasks?'mt-status danger':'mt-status'}>{item.overdueTasks}</span></td>
        </tr>)}</tbody>
      </table></div>
    </section>}

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
