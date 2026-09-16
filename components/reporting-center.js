import Link from 'next/link';
import ReportExcelButton from './report-excel-button';
import styles from './reporting-center.module.css';
import {REPORT_DATE_PRESETS,reportQuery} from '../lib/reporting';

const REPORT_TABS=[
  ['overview','لوحة التقارير','',null],
  ['employees','أداء الموظفين','/employees',null],
  ['sales','تقارير المبيعات','/sales','sales'],
  ['campaigns','تقارير الحملات','/campaigns','campaigns'],
  ['calls','أداء المكالمات','/call-reports','sales']
];

const STATUS_LABELS={
  new:'جديد',contacted:'تم التواصل',no_answer:'لا يرد',interested:'مهتم',
  very_interested:'مهتم جدًا',awaiting_payment:'بانتظار الدفع',paid:'تم الدفع',
  not_interested:'غير مهتم',unqualified:'غير مؤهل',wrong_number:'رقم خاطئ',
  duplicate:'مكرر',cancelled:'ملغي',open:'مفتوح',won:'محقق',lost:'مفقود',
  todo:'لم يبدأ',in_progress:'قيد التنفيذ',completed:'مكتمل',cancelled_task:'ملغي'
};

const ACTIVITY_LABELS={
  call:'مكالمة',whatsapp:'واتساب',meeting:'اجتماع',note:'ملاحظة',offer:'عرض',email:'بريد إلكتروني'
};

function number(value){
  return new Intl.NumberFormat('ar-EG',{maximumFractionDigits:1}).format(Number(value)||0);
}
function percent(value){return value===null||value===undefined?'غير مقاس':`${number(value)}٪`;}
function moneyMinor(value){
  return new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR',maximumFractionDigits:0}).format((Number(value)||0)/100);
}
function duration(seconds){
  const total=Math.max(0,Number(seconds)||0);
  const hours=Math.floor(total/3600);
  const minutes=Math.round((total%3600)/60);
  return hours?`${number(hours)} س ${number(minutes)} د`:`${number(minutes)} د`;
}
function shortDate(value){
  if(!value)return '—';
  return new Intl.DateTimeFormat('ar-SA',{day:'numeric',month:'short'}).format(new Date(value));
}
function dateTime(value){
  if(!value)return '—';
  return new Intl.DateTimeFormat('ar-SA',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}).format(new Date(value));
}
function score(employee){
  const values=[employee.conversionRate,employee.taskCompletionRate,employee.callAnswerRate,employee.dataCompletenessRate,employee.firstResponseSlaRate]
    .filter(value=>value!==null&&value!==undefined&&Number.isFinite(Number(value)));
  if(!values.length)return null;
  return Math.round(values.reduce((total,value)=>total+Number(value),0)/values.length);
}
function metric(label,value,note,tone='blue'){return {label,value,note,tone};}

function metricsFor(view,summary){
  const revenue=summary.realizedRevenueMinor||0;
  if(view==='sales')return [
    metric('العملاء الجدد',number(summary.leadsCreated),'دخلوا النظام خلال الفترة','blue'),
    metric('المدفوعات المؤكدة',number(summary.paidContacts),'عملاء تم التحقق من مدفوعاتهم','green'),
    metric('الإيراد المحقق',moneyMinor(revenue),'من المدفوعات التي تم التحقق منها','green'),
    metric('نسبة التحويل',percent(summary.conversionRate),'من العملاء الجدد إلى الدفع','purple'),
    metric('قيمة المسار المفتوح',moneyMinor(summary.pipelineValueMinor),'فرص مفتوحة حاليًا','cyan'),
    metric('متوسط قيمة البيع',moneyMinor(summary.averageSaleMinor),'للحالة المحققة','amber')
  ];
  if(view==='campaigns')return [
    metric('عملاء الحملات',number(summary.leadsCreated),'داخل الفترة المختارة','blue'),
    metric('مدفوعات مؤكدة',number(summary.paidContacts),'من عملاء الفترة بعد التحقق','green'),
    metric('قيمة المبيعات',moneyMinor(revenue),'منسوبة للمصدر والحملة','green'),
    metric('التحويل العام',percent(summary.conversionRate),'من العميل إلى الدفع','cyan')
  ];
  return [
    metric('العملاء المسندون',number(summary.leadsAssigned),'عملاء فريدون تم إسنادهم خلال الفترة بغض النظر عن نتيجتهم اللاحقة','blue'),
    metric('عمليات الإسناد',number(summary.assignmentOperations),'تشمل إعادة توزيع العميل إن حدثت','cyan'),
    metric('الصالحون بعد المعالجة',number(summary.validAssignedLeads),'بعد استبعاد الرقم الخاطئ وغير المؤهل والمكرر','amber'),
    metric('المدفوعات المؤكدة',number(summary.paidContacts),'حالات تم التحقق من دفعها','green'),
    metric('قيمة المبيعات',moneyMinor(revenue),'قيمة محققة خلال الفترة','green'),
    metric('أنشطة المتابعة',number(summary.activities),'مكالمات ومتابعات مسجلة','purple'),
    metric('إنجاز المهام',percent(summary.taskCompletionRate),`${number(summary.tasksCompleted)} من ${number(summary.tasksTotal)} مهمة`,'cyan'),
    metric('المكالمات',number(summary.calls),`${percent(summary.callAnswerRate)} نسبة الرد`,'cyan'),
    metric('اكتمال البيانات',percent(summary.dataCompletenessRate),'الاسم والجوال والمصدر والدورة والمالك','amber'),
    metric('الالتزام بأول إجراء',percent(summary.firstResponseSlaRate),'مقارنة بموعد التوزيع المحدد','pink')
  ];
}

function PeriodFilter({range,analytics,exportPayload}){
  const canUseAnalytics=Boolean(analytics?.canUseAnalytics);
  const selectedStaff=canUseAnalytics&&range.staffId
    ?(analytics.staff||[]).find(staff=>staff.staffId===range.staffId)
    :null;
  return <form className={styles.period} method="get">
    <div className={styles.presets}>
      <span>اختيار سريع للفترة</span>
      <div className={styles.presetButtons} aria-label="فترات تاريخ جاهزة">
        {REPORT_DATE_PRESETS.map(preset=><button
          key={preset.key}
          type="submit"
          name="period"
          value={preset.key}
          className={`${styles.presetButton} ${range.period===preset.key?styles.activePreset:''}`}
          aria-pressed={range.period===preset.key}
        >{preset.label}</button>)}
      </div>
    </div>
    <label><span>من تاريخ</span><input type="date" name="from" defaultValue={range.from}/></label>
    <label><span>إلى تاريخ</span><input type="date" name="to" defaultValue={range.to}/></label>
    {canUseAnalytics&&<label className={styles.staffFilter}>
      <span>اسم الموظف</span>
      <select
        name="staffId"
        defaultValue={range.staffId||''}
      >
        <option value="">كل الموظفين</option>
        {(analytics.staff||[]).map(staff=><option key={staff.staffId} value={staff.staffId}>
          {staff.fullName}{staff.extensions?.length?` · ${staff.extensions.join('، ')}`:''}
        </option>)}
      </select>
    </label>}
    <button className={styles.applyButton} type="submit">تطبيق الفلاتر</button>
    {canUseAnalytics&&<ReportExcelButton payload={{...exportPayload,section:'all'}} label="تصدير التقرير XLSX"/>}
    <small className={styles.filterHint} role="status">
      {selectedStaff
        ?<>يتم تصفية جميع المؤشرات والرسوم البيانية والجداول حسب الموظف: <b>{selectedStaff.fullName}</b>.</>
        :'تُطبّق الفترة المختارة على جميع المؤشرات والرسوم البيانية والجداول في اللوحة.'}
    </small>
  </form>;
}

function ReportTabs({slug,view,range,availability={},personalOnly=false}){
  const tenantBase=`/tenant/${encodeURIComponent(slug)}`;
  const query=reportQuery(range);
  return <nav className={styles.tabs} aria-label="أنواع التقارير">
    {REPORT_TABS.filter(([, , ,capability])=>!capability||availability[capability]!==false).map(([key,label,path])=>{
      const href=key==='calls'?`${tenantBase}${path}?${query}`:`${tenantBase}/reports${path}?${query}`;
      return <Link key={key} href={href} className={view===key?styles.activeTab:''}>
        {key==='employees'&&personalOnly?'أدائي':label}
      </Link>;
    })}
  </nav>;
}

function ExportAction({canExport,payload,section,label='تصدير XLSX'}){
  return canExport?<ReportExcelButton payload={{...payload,section}} label={label} compact/>:null;
}

function MetricGrid({items,canExport,exportPayload}){
  return <div style={{display:'grid',gap:8}}>
    {canExport&&<div style={{display:'flex',justifyContent:'flex-end'}}>
      <ExportAction canExport payload={exportPayload} section="metrics" label="تصدير المؤشرات XLSX"/>
    </div>}
    <section className={styles.metrics} aria-label="مؤشرات الفترة">
      {items.map(item=><article className={`${styles.metric} ${styles[item.tone]||''}`} key={item.label}>
        <span>{item.label}</span><b>{item.value}</b><small>{item.note}</small>
      </article>)}
    </section>
  </div>;
}

function chartBuckets(daily=[],maxBuckets=14){
  if(daily.length<=maxBuckets)return daily;
  const size=Math.ceil(daily.length/maxBuckets);
  const result=[];
  for(let index=0;index<daily.length;index+=size){
    const rows=daily.slice(index,index+size);
    result.push({
      date:rows[0].date,label:rows.length===1?shortDate(rows[0].date):`${shortDate(rows[0].date)}–${shortDate(rows.at(-1).date)}`,
      leadsAssigned:rows.reduce((sum,row)=>sum+(Number(row.leadsAssigned)||0),0),
      leadsCreated:rows.reduce((sum,row)=>sum+(Number(row.leadsCreated)||0),0),
      activities:rows.reduce((sum,row)=>sum+(Number(row.activities)||0),0),
      paid:rows.reduce((sum,row)=>sum+(Number(row.paid)||0),0),
      tasksCompleted:rows.reduce((sum,row)=>sum+(Number(row.tasksCompleted)||0),0),
      calls:rows.reduce((sum,row)=>sum+(Number(row.calls)||0),0)
    });
  }
  return result;
}

function TrendChart({daily=[],view='overview'}){
  const rows=chartBuckets(daily);
  const series=view==='sales'
    ?[['leadsCreated','عملاء جدد','blue'],['activities','متابعات','purple'],['paid','مبيعات','green']]
    :[['leadsAssigned','عملاء','blue'],['activities','متابعات','purple'],['tasksCompleted','مهام','amber'],['calls','مكالمات','cyan']];
  const max=Math.max(1,...rows.flatMap(row=>series.map(([key])=>Number(row[key])||0)));
  return <article className={`${styles.panel} ${styles.trendPanel}`}>
    <header className={styles.panelHead}>
      <div><span>اتجاه الفترة</span><h3>الحركة اليومية ومخرجات الأداء</h3></div>
      <div className={styles.legend}>{series.map(([,label,tone])=><span key={label}><i className={styles[tone]}/>{label}</span>)}</div>
    </header>
    <div className={styles.chart}>
      {rows.map(row=><div className={styles.chartDay} key={row.date}>
        <div className={styles.bars}>{series.map(([key,label,tone])=><i key={key} className={styles[tone]} style={{height:`${Math.max(3,(Number(row[key])||0)/max*100)}%`}} title={`${label}: ${number(row[key])}`}/>)}</div>
        <small>{row.label||shortDate(row.date)}</small>
      </div>)}
      {!rows.length&&<div className={styles.empty}>لا توجد حركة ضمن الفترة المختارة.</div>}
    </div>
  </article>;
}

function Breakdown({title,eyebrow,items=[],valueKey='count',labelKey='label'}){
  const max=Math.max(1,...items.map(item=>Number(item[valueKey])||0));
  return <article className={styles.panel}>
    <header className={styles.panelHead}><div><span>{eyebrow}</span><h3>{title}</h3></div></header>
    <div className={styles.breakdown}>
      {items.map((item,index)=>{
        const value=Number(item[valueKey])||0;
        const label=item[labelKey]||STATUS_LABELS[item.key]||ACTIVITY_LABELS[item.key]||item.key||'غير محدد';
        return <div key={`${label}-${index}`}><div><b>{label}</b><span>{number(value)}</span></div><i><span style={{width:`${Math.max(2,value/max*100)}%`}}/></i></div>;
      })}
      {!items.length&&<div className={styles.empty}>لا توجد بيانات كافية لهذا التحليل.</div>}
    </div>
  </article>;
}

function EmployeeTable({employees=[],slug,range,compact=false,canExport=false,exportPayload}){
  const sorted=[...employees].sort((a,b)=>(score(b)??-1)-(score(a)??-1)||Number(b.realizedRevenueMinor||0)-Number(a.realizedRevenueMinor||0));
  const rows=compact?sorted.slice(0,8):sorted;
  return <article className={`${styles.panel} ${styles.widePanel}`}>
    <header className={styles.panelHead}>
      <div><span>تفصيل قابل للفتح</span><h3>أداء الموظفين خلال الفترة</h3></div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <ExportAction canExport={canExport} payload={exportPayload} section="employees"/>
        {compact&&<Link href={`/tenant/${encodeURIComponent(slug)}/reports/employees?${reportQuery(range)}`}>عرض كل الموظفين</Link>}
      </div>
    </header>
    <div className={styles.tableWrap}><table>
      <thead><tr><th>الموظف</th><th>مؤشر الأداء</th><th>العملاء</th><th>مدفوعات مؤكدة</th><th>القيمة</th><th>المهام</th><th>المكالمات</th><th>اكتمال البيانات</th><th>أول إجراء</th></tr></thead>
      <tbody>{rows.map(employee=>{
        const employeeScore=score(employee);
        return <tr key={employee.staffId}>
          <td><Link prefetch={false} className={styles.employeeLink} href={`/tenant/${encodeURIComponent(slug)}/reports/employees/${employee.staffId}?${reportQuery(range)}`}><b>{employee.name}</b><small>{employee.jobTitle||employee.roleLabel||'موظف'}</small></Link></td>
          <td>{employeeScore===null?<span className={styles.muted}>لا توجد عينة</span>:<span className={styles.score}>{number(employeeScore)}٪</span>}</td>
          <td><b>{number(employee.leadsAssigned)}</b><small>{number(employee.activities)} متابعة</small></td>
          <td><b>{number(employee.paidContacts)}</b><small>{percent(employee.conversionRate)}</small></td>
          <td>{moneyMinor(employee.realizedRevenueMinor)}</td>
          <td><b>{percent(employee.taskCompletionRate)}</b><small>{number(employee.tasksCompleted)}/{number(employee.tasksTotal)}</small></td>
          <td><b>{number(employee.calls)}</b><small>{percent(employee.callAnswerRate)}</small></td>
          <td>{percent(employee.dataCompletenessRate)}</td><td>{percent(employee.firstResponseSlaRate)}</td>
        </tr>;
      })}
      {!rows.length&&<tr><td colSpan="9"><div className={styles.empty}>لا توجد ملفات موظفين ضمن نطاق صلاحيتك.</div></td></tr>}</tbody>
    </table></div>
  </article>;
}

function CampaignTable({campaigns=[],compact=false,canExport=false,exportPayload}){
  const rows=compact?campaigns.slice(0,8):campaigns;
  return <article className={`${styles.panel} ${styles.widePanel}`}>
    <header className={styles.panelHead}>
      <div><span>الإسناد التسويقي</span><h3>نتائج المصادر والحملات والإعلانات</h3></div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}><ExportAction canExport={canExport} payload={exportPayload} section="campaigns"/><small>لا تُحسب تكلفة الإعلان قبل ربط منصات الإعلانات</small></div>
    </header>
    <div className={styles.tableWrap}><table>
      <thead><tr><th>المصدر</th><th>الحملة</th><th>الإعلان</th><th>العملاء</th><th>تمت متابعتهم</th><th>مدفوعات مؤكدة</th><th>التحويل</th><th>القيمة</th><th>اكتمال البيانات</th></tr></thead>
      <tbody>{rows.map((campaign,index)=><tr key={`${campaign.source}-${campaign.campaign}-${campaign.ad}-${index}`}>
        <td><b>{campaign.source||'غير محدد'}</b></td><td>{campaign.campaign||'بدون اسم حملة'}</td><td>{campaign.ad||'بدون اسم إعلان'}</td>
        <td>{number(campaign.leads)}</td><td>{number(campaign.touchedLeads)}</td><td>{number(campaign.paidContacts)}</td><td>{percent(campaign.conversionRate)}</td><td>{moneyMinor(campaign.revenueMinor)}</td><td>{percent(campaign.dataCompletenessRate)}</td>
      </tr>)}
      {!rows.length&&<tr><td colSpan="9"><div className={styles.empty}>لا توجد حملات ضمن الفترة المختارة.</div></td></tr>}</tbody>
    </table></div>
  </article>;
}

function CourseTable({courses=[],canExport=false,exportPayload}){
  return <article className={styles.panel}>
    <header className={styles.panelHead}><div><span>تحليل المنتجات</span><h3>المبيعات حسب الدورة</h3></div><ExportAction canExport={canExport} payload={exportPayload} section="courses"/></header>
    <div className={styles.simpleRows}>{courses.slice(0,10).map(course=><div key={course.courseId||course.name}>
      <span><b>{course.name||'دورة غير محددة'}</b><small>{number(course.leads)} عميل</small></span>
      <span><b>{number(course.paidContacts)} مدفوعات مؤكدة</b><small>{moneyMinor(course.revenueMinor)}</small></span>
    </div>)}
    {!courses.length&&<div className={styles.empty}>لم تُربط مبيعات بدورات خلال الفترة.</div>}</div>
  </article>;
}

function ReportDirectory({slug,range,data}){
  const summary=data.summary||{};
  const availability=data.availability||{};
  const personalOnly=data.viewer?.scope==='employee'||availability.team===false;
  const cards=[
    [personalOnly?'أدائي':'أداء الموظفين',personalOnly?'تقريرك الشخصي في المبيعات والمهام والمكالمات وجودة استكمال البيانات.':'قائمة الموظفين ثم تقرير شامل لكل موظف بالمبيعات والمهام والمكالمات وجودة البيانات.',`/tenant/${slug}/reports/employees`,personalOnly?'تقريري':`${number(data.employees?.length)} موظف`,null],
    ['تقارير المبيعات','اتجاه المبيعات والمسار والتحويل والدورات خلال أي فترة.',`/tenant/${slug}/reports/sales`,`${number(summary.paidContacts)} مدفوعات مؤكدة`,'sales'],
    ['تقارير الحملات','المصدر والحملة والإعلان والعملاء والمتابعة والتحويل والقيمة المحققة.',`/tenant/${slug}/reports/campaigns`,`${number(summary.campaignCount)} حملة`,'campaigns'],
    ['أداء المكالمات','المكالمات الواردة والصادرة والفائتة ونسبة الرد وأداء التحويلات.',`/tenant/${slug}/call-reports`,`${number(summary.calls)} مكالمة`,'sales']
  ];
  return <section className={styles.directory}>{cards.filter(([, , , ,capability])=>!capability||availability[capability]!==false).map(([title,description,href,badge])=><Link key={title} href={`${href}?${reportQuery(range)}`}>
    <span>{badge}</span><h3>{title}</h3><p>{description}</p><b>فتح التقرير التفصيلي ←</b>
  </Link>)}</section>;
}

function DetailTables({details={},canExport=false,exportPayload}){
  const head=(eyebrow,title)=><header className={styles.panelHead}><div><span>{eyebrow}</span><h3>{title}</h3></div><ExportAction canExport={canExport} payload={exportPayload} section="details"/></header>;
  return <section className={styles.detailGrid}>
    <article className={styles.panel}>{head('سجل العمل','المهام خلال الفترة')}<div className={styles.detailList}>{(details.tasks||[]).map(task=><div key={task.id}><span><b>{task.title}</b><small>{task.contactName||'مهمة تشغيلية'}</small></span><span><b>{STATUS_LABELS[task.status]||task.status}</b><small>{dateTime(task.dueAt)}</small></span></div>)}{!details.tasks?.length&&<div className={styles.empty}>لا توجد مهام في الفترة.</div>}</div></article>
    <article className={styles.panel}>{head('تواصل مسجل','المتابعات والأنشطة')}<div className={styles.detailList}>{(details.activities||[]).map(activity=><div key={activity.id}><span><b>{activity.contactName}</b><small>{activity.summary||ACTIVITY_LABELS[activity.type]||activity.type}</small></span><span><b>{ACTIVITY_LABELS[activity.type]||activity.type}</b><small>{dateTime(activity.occurredAt)}</small></span></div>)}{!details.activities?.length&&<div className={styles.empty}>لا توجد متابعات مسجلة في الفترة.</div>}</div></article>
    <article className={styles.panel}>{head('Yeastar','أحدث المكالمات')}<div className={styles.detailList}>{(details.calls||[]).map(call=><div key={call.id}><span><b dir="ltr">{call.otherNumber||'—'}</b><small>{call.callType==='Outbound'?'صادرة':call.callType==='Inbound'?'واردة':'داخلية'}</small></span><span><b>{call.finalStatus==='ANSWERED'?'تم الرد':'لم يتم الرد'}</b><small>{duration(call.talkSeconds)} · {dateTime(call.startedAt)}</small></span></div>)}{!details.calls?.length&&<div className={styles.empty}>لا توجد مكالمات مرتبطة بهذا الموظف في الفترة.</div>}</div></article>
    <article className={styles.panel}>{head('جودة الملف','العملاء المسندون')}<div className={styles.detailList}>{(details.leads||[]).map(lead=><div key={lead.id}><span><b>{lead.name}</b><small>{lead.source||'مصدر غير محدد'} · {lead.courseName||'دورة غير محددة'}</small></span><span><b>{STATUS_LABELS[lead.status]||lead.status}</b><small>{percent(lead.completenessRate)} مكتمل</small></span></div>)}{!details.leads?.length&&<div className={styles.empty}>لا توجد إسنادات في الفترة.</div>}</div></article>
  </section>;
}

function EmployeeHero({employee,summary}){
  return <section className={styles.employeeHero}>
    <div className={styles.avatar}>{Array.from(employee?.name||'م')[0]}</div>
    <div><span>تقرير أداء موظف</span><h2>{employee?.name||'الموظف'}</h2><p>{employee?.jobTitle||employee?.roleLabel||'موظف المنشأة'} · التقرير مبني على الحركة الفعلية داخل الفترة.</p></div>
    <aside><span>مؤشر الأداء المجمع</span><b>{percent(score({...summary}))}</b><small>متوسط المؤشرات المتاحة فقط</small></aside>
  </section>;
}

export default function ReportingCenter({data,slug,view='overview',range,analytics,campaignNavigation=null,campaignSpendOverview=null,campaignRecommendations=null}){
  const summary=data?.summary||{};
  const selectedEmployee=data?.selectedEmployee||null;
  const availability=data?.availability||{};
  const personalOnly=data?.viewer?.scope==='employee'||availability.team===false;
  const canExport=Boolean(analytics?.canUseAnalytics);
  const report=view==='employee'?'employee':view;
  const exportPayload={
    slug,
    report,
    from:range.from,
    to:range.to,
    staffId:view==='employee'?(selectedEmployee?.staffId||range.staffId):range.staffId
  };
  const title=view==='employees'?'أداء الموظفين':view==='employee'?`تقرير ${selectedEmployee?.name||'الموظف'}`:view==='sales'?'تقارير المبيعات':view==='campaigns'?'الملخص التنفيذي للحملات':'لوحة التقارير';
  const description=view==='employee'?'قراءة موحّدة للمبيعات والمهام والمكالمات والمتابعة وجودة استكمال البيانات.':'حوّل الفترة المختارة إلى مؤشرات قابلة للفهم ثم افتح التفاصيل حتى السجل الأصلي.';

  return <div className={`${styles.workspace} ${view==='campaigns'?styles.campaignWorkspace:''}`}>
    <section className={styles.hero}>
      <div><span>التقارير والتحليلات</span><h1>{title}</h1><p>{description}</p></div>
      <PeriodFilter range={range} analytics={analytics} exportPayload={exportPayload}/>
    </section>
    {view!=='campaigns'?<ReportTabs slug={slug} view={view==='employee'?'employees':view} range={range} availability={availability} personalOnly={personalOnly}/>:null}
    {view==='campaigns'?campaignNavigation:null}
    {view==='campaigns'?campaignSpendOverview:null}
    {view==='employee'&&<EmployeeHero employee={selectedEmployee} summary={summary}/>}
    <MetricGrid items={metricsFor(view,summary)} canExport={canExport} exportPayload={exportPayload}/>
    {view==='campaigns'?campaignRecommendations:null}

    {view==='overview'&&<>
      <ReportDirectory slug={slug} range={range} data={data}/>
      <section className={styles.twoColumns}><TrendChart daily={data.daily||[]} view="overview"/><Breakdown eyebrow="حالة العملاء" title="توزيع العملاء خلال الفترة" items={data.leadStatuses||[]}/></section>
      <EmployeeTable employees={data.employees||[]} slug={slug} range={range} compact canExport={canExport} exportPayload={exportPayload}/>
      {availability.campaigns!==false&&<CampaignTable campaigns={data.campaigns||[]} compact canExport={canExport} exportPayload={exportPayload}/>} 
    </>}

    {view==='employees'&&<>
      <section className={styles.twoColumns}><TrendChart daily={data.daily||[]}/><Breakdown eyebrow="مستوى التنفيذ" title="حالات المهام" items={data.taskBreakdown||[]}/></section>
      <EmployeeTable employees={data.employees||[]} slug={slug} range={range} canExport={canExport} exportPayload={exportPayload}/>
    </>}

    {view==='employee'&&<>
      <section className={styles.twoColumns}><TrendChart daily={data.daily||[]}/><Breakdown eyebrow="أنواع المتابعة" title="توزيع أنشطة الموظف" items={data.activityBreakdown||[]}/></section>
      <section className={styles.threeColumns}><Breakdown eyebrow="المهام" title="حالات المهام" items={data.taskBreakdown||[]}/><Breakdown eyebrow="العملاء" title="حالات العملاء" items={data.leadStatuses||[]}/><Breakdown eyebrow="الاتصالات" title="نتائج المكالمات" items={data.callBreakdown||[]}/></section>
      <DetailTables details={data.details||{}} canExport={canExport} exportPayload={exportPayload}/>
    </>}

    {view==='sales'&&<>
      <section className={styles.twoColumns}><TrendChart daily={data.daily||[]} view="sales"/><Breakdown eyebrow="مسار المبيعات" title="الفرص حسب المرحلة" items={data.pipelineStages||[]} valueKey="valueMinor" labelKey="name"/></section>
      <EmployeeTable employees={data.employees||[]} slug={slug} range={range} compact canExport={canExport} exportPayload={exportPayload}/>
      <section className={styles.twoColumns}><CourseTable courses={data.courses||[]} canExport={canExport} exportPayload={exportPayload}/><Breakdown eyebrow="حالة العميل" title="قمع التحويل" items={data.leadStatuses||[]}/></section>
    </>}

    {view==='campaigns'&&<>
      <CampaignTable campaigns={data.campaigns||[]} canExport={canExport} exportPayload={exportPayload}/>
      <details className={styles.campaignDetails}><summary>تفاصيل توزيع العملاء والتحويل حسب المصدر</summary><section className={styles.twoColumns}><Breakdown eyebrow="مصادر العملاء" title="حجم العملاء حسب المصدر" items={data.sources||[]} labelKey="source" valueKey="leads"/><Breakdown eyebrow="جودة التحويل" title="المبيعات حسب المصدر" items={data.sources||[]} labelKey="source" valueKey="paidContacts"/></section></details>
      <div className={styles.dataNote}><b>حدود القياس الحالية</b><p>الأرقام تنسب العميل والمبيعات إلى المصدر والحملة والإعلان المسجلين داخل CRM. ملخص إنفاق المنصات يظهر أعلى التقرير عند توفره. مقارنة التكلفة بالتحصيل تحتاج ربط المصادر ومزامنة الفترة؛ لا تُقدّر الأرقام غير المتاحة.</p></div>
    </>}
  </div>;
}

export function ReportsUnavailable({message}){
  return <div className={styles.unavailable}><span>!</span><h2>تعذر تحميل مركز التقارير</h2><p>{message||'أعد المحاولة بعد قليل، وإن استمرت المشكلة راجع صلاحية التقارير أو اكتمال تحديث قاعدة البيانات.'}</p></div>;
}

