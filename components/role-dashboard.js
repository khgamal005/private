import Link from 'next/link';
import styles from './role-dashboard.module.css';

const ROLE_COPY={
  tenant_owner:{
    eyebrow:'الرؤية التنفيذية',
    title:'لوحة قيادة المنشأة',
    description:'صورة موحّدة تربط الإيرادات والعملاء والإعلانات والمكالمات والطلاب والفريق والتشغيل في قرار واحد.'
  },
  tenant_admin:{
    eyebrow:'إدارة المنشأة',
    title:'لوحة الأداء التشغيلي',
    description:'مؤشرات التشغيل والحسابات والمهام التي تحتاج تدخلًا إداريًا.'
  },
  executive_manager:{
    eyebrow:'الإدارة التنفيذية',
    title:'لوحة القيادة التنفيذية',
    description:'الأداء التجاري والتشغيلي في شاشة واحدة قابلة للمتابعة اليومية.'
  },
  sales_manager:{
    eyebrow:'إدارة المبيعات',
    title:'لوحة أداء فريق المبيعات',
    description:'المسار والتحويل وسرعة الاستجابة والمكالمات لكل مسؤول.'
  },
  sales_supervisor:{
    eyebrow:'الإشراف اليومي',
    title:'لوحة متابعة المبيعات',
    description:'متابعة نشاط الفريق والمهام المتأخرة وجودة الرد على العملاء.'
  },
  sales_user:{
    eyebrow:'أدائي اليوم',
    title:'لوحة أداء مسؤول المبيعات',
    description:'عملاؤك ومتابعاتك ومكالماتك وحوافزك دون بيانات زملائك.'
  },
  customer_service:{
    eyebrow:'خدمة العملاء',
    title:'لوحة أداء خدمة العملاء',
    description:'طلبات التسجيل والردود والمكالمات والمهام المطلوب إغلاقها.'
  },
  data_officer:{
    eyebrow:'تشغيل البيانات',
    title:'لوحة جودة وتوزيع البيانات',
    description:'حالة الاستيراد والتنظيف والتوزيع والالتزام بزمن أول متابعة.'
  },
  data_analyst:{
    eyebrow:'تحليل الأداء',
    title:'لوحة تحليلات المنشأة',
    description:'مصادر العملاء والتحويل وجودة البيانات وسرعة الاستجابة.'
  },
  training_manager:{
    eyebrow:'إدارة التدريب',
    title:'لوحة أداء التدريب',
    description:'المجموعات والجلسات والحضور والتقييم والشهادات والتنبيهات.'
  },
  tenant_user:{
    eyebrow:'مساحة العمل',
    title:'لوحة أدائي',
    description:'مهامك ومؤشراتك اليومية داخل المنشأة.'
  }
};

const ROLE_LABELS={
  tenant_owner:'مالك المنشأة',
  tenant_admin:'مدير المنشأة',
  executive_manager:'المدير التنفيذي',
  sales_manager:'مدير المبيعات',
  sales_supervisor:'مشرف المبيعات',
  sales_user:'مسؤول المبيعات',
  customer_service:'خدمة العملاء',
  data_officer:'مسؤول البيانات',
  data_analyst:'محلل البيانات',
  training_manager:'مدير التدريب'
};

const SALES_ROLES=new Set(['sales_manager','sales_supervisor','sales_user']);
const EXECUTIVE_ROLES=new Set([
  'tenant_owner',
  'tenant_admin',
  'executive_manager'
]);
const DATA_ROLES=new Set(['data_officer','data_analyst']);
const OPEN_TASK_STATUSES=new Set(['todo','in_progress']);

function number(value){
  return new Intl.NumberFormat('ar-EG').format(Number(value)||0);
}

function percent(value){
  return `${number(value)}٪`;
}

function moneyMinor(value){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:'SAR',
    maximumFractionDigits:0
  }).format((Number(value)||0)/100);
}

function moneyMinorCurrency(value,currency='SAR'){
  const normalized=/^[A-Z]{3}$/.test(String(currency||'').toUpperCase())
    ?String(currency).toUpperCase()
    :'SAR';
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:normalized,
    maximumFractionDigits:0
  }).format((Number(value)||0)/100);
}

function moneyMinorCurrencyExact(value,currency='SAR',minorDigits=2){
  if(value==null||!Number.isFinite(Number(value)))return '—';
  const normalized=/^[A-Z]{3}$/.test(String(currency||'').toUpperCase())
    ?String(currency).toUpperCase()
    :'SAR';
  const digits=Math.min(4,Math.max(0,Number(minorDigits)||0));
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:normalized,
    minimumFractionDigits:digits,
    maximumFractionDigits:digits
  }).format((Number(value)||0)/(10**digits));
}

function ratio(value){
  if(value==null||!Number.isFinite(Number(value)))return '—';
  return `${new Intl.NumberFormat('ar-EG',{
    maximumFractionDigits:2
  }).format(Number(value))}×`;
}

function money(value){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:'SAR',
    maximumFractionDigits:0
  }).format(Number(value)||0);
}

function duration(seconds){
  const total=Math.max(0,Number(seconds)||0);
  const hours=Math.floor(total/3600);
  const minutes=Math.round((total%3600)/60);
  if(hours)return `${number(hours)} س ${number(minutes)} د`;
  return `${number(minutes)} دقيقة`;
}

function when(value){
  if(!value)return 'الآن';
  return new Intl.DateTimeFormat('ar-EG',{
    day:'numeric',
    month:'short',
    hour:'numeric',
    minute:'2-digit'
  }).format(new Date(value));
}

function metric(label,value,note,tone='blue',featured=false){
  return {label,value,note,tone,featured};
}

function roleMetrics(role,dashboard,marketing,canReadMarketing){
  const personal=dashboard.personal||{};
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const calls=dashboard.telephony||{};
  const leads=dashboard.leadOperations||{};
  const training=dashboard.training||{};
  const marketingSummary=marketing?.summary||{};

  if(EXECUTIVE_ROLES.has(role)){
    const woo=executive.woocommerceRevenue||{};
    const wooTotals=woo.totals||{};
    const wooMoney=value=>moneyMinorCurrencyExact(
      value,
      woo.currency,
      woo.minorDigits
    );
    const items=[];
    const hasWooRevenue=woo.available
      &&Number.isFinite(Number(wooTotals.netSalesMinor))
      &&wooTotals.netSalesMinor!=null;
    if(woo.connected){
      items.push(metric(
        'صافي مبيعات WooCommerce هذا الشهر',
        hasWooRevenue?wooMoney(wooTotals.netSalesMinor):'التقرير غير متاح',
        hasWooRevenue
          ?`${number(wooTotals.orderCount)} طلبًا · `
            +`الإجمالي ${wooMoney(wooTotals.grossSalesMinor)} · `
            +`الخصومات ${wooMoney(wooTotals.couponsMinor)}`
            +`${Number(wooTotals.returnsMinor)>0
              ?` · المرتجعات ${wooMoney(wooTotals.returnsMinor)}`
              :''}`
            +`${woo.stale?' · البيانات تحتاج مزامنة حديثة':''}`
          :woo.error
            ?'تعذر جلب تقرير WooCommerce الرسمي في آخر محاولة؛ راجع صلاحيات Analytics ثم أعد الاختبار.'
            :'سيظهر رقم WooCommerce الرسمي بعد اكتمال مزامنة تشمل الطلبات.',
        hasWooRevenue?'green':'amber',
        true
      ));
    }
    items.push(
      metric(
        'دفعات التسجيل المؤكدة هذا الشهر',
        moneyMinor(executive.wonRevenueMinor),
        'دفعات تم التحقق منها في سجل القبول داخل المنصة؛ وتظهر منفصلة لمنع الازدواج',
        'green'
      ),
      metric(
        'قيمة المسار',
        moneyMinor(executive.pipelineValueMinor),
        'القيمة الإجمالية للفرص المفتوحة حاليًا',
        'blue',
        true
      ),
      metric('حسابات الدخول',number(executive.activeAccounts),`من ${number(executive.activeStaff)} موظف`,'purple'),
      metric('طلاب ومتدربون نشطون',number(training.activeEnrollments),`${number(training.activeCourseRuns)} مجموعات نشطة`,'green'),
      metric('طلبات قبول معلّقة',number(executive.pendingAdmissions),'تحتاج متابعة','amber'),
      metric('مكالمات الشهر',number(calls.totalCalls),`${percent(calls.answerRate)} نسبة الرد`,'cyan'),
      metric('مجموعات نشطة',number(executive.activeCourseRuns),'مفتوحة أو جارية','pink')
    );
    if(canReadMarketing){
      items.splice(4,0,metric(
        'الإنفاق الإعلاني — 30 يومًا',
        marketing
          ?moneyMinorCurrency(
            marketingSummary.spendMinor,
            marketingSummary.currency
          )
          :'—',
        marketing
          ?`${number(marketingSummary.platformLeads)} نتيجة حسب المنصات`
          :'تعذر تحميل بيانات الإعلانات الموثوقة',
        'purple'
      ));
    }
    return items;
  }
  if(SALES_ROLES.has(role)){
    return [
      metric('عملاء قيد المتابعة',number(sales.activeLeads),'داخل مسارك الحالي','blue'),
      metric('مدفوعات مؤكدة هذا الشهر',number(sales.paidThisMonth),`${percent(sales.conversionRate)} تحويل · ${number(sales.pendingPaymentVerification)} قيد التحقق`,'green'),
      metric('أنشطة اليوم',number(sales.activitiesToday??personal.activitiesToday),'مكالمة أو متابعة مسجلة','purple'),
      metric('متابعات متأخرة',number(sales.overdueFollowUps),'تحتاج إجراء الآن','amber'),
      metric('مكالمات الشهر',number(calls.totalCalls),`${number(calls.answeredCalls)} مجاب عليها`,'cyan'),
      metric('الالتزام بأول رد',percent(sales.firstResponseSlaRate),`${number(sales.averageFirstResponseMinutes)} د متوسط`,'pink')
    ];
  }
  if(role==='customer_service'){
    return [
      metric('طلبات قبول معلّقة',number(training.pendingAdmissions),'تحتاج مراجعة','blue'),
      metric('تحقق دفع معلّق',number(training.pendingPaymentVerification),'حالات بانتظار الإجراء','amber'),
      metric('مهام اليوم',number(personal.tasksToday),`${number(personal.openTasks)} مفتوحة`,'purple'),
      metric('مكالمات الشهر',number(calls.totalCalls),`${number(calls.missedCalls)} فائتة`,'cyan'),
      metric('نسبة الرد',percent(calls.answerRate),duration(calls.averageTalkSeconds),'green'),
      metric('مهام متأخرة',number(personal.overdueTasks),'تحتاج إغلاقًا أو إعادة جدولة','pink')
    ];
  }
  if(DATA_ROLES.has(role)){
    return [
      metric('صفوف هذا الشهر',number(leads.totalRows),`${number(leads.batchesThisMonth)} دفعة`,'blue'),
      metric('بيانات صالحة',number(leads.validRows),'جاهزة للتوزيع','green'),
      metric('بيانات غير صالحة',number(leads.invalidRows),'تحتاج تنظيفًا','pink'),
      metric('تكرارات',number(leads.duplicateRows),'لا تُوزع مرتين','amber'),
      metric('بانتظار التوزيع',number(leads.awaitingDistribution),'عملاء جاهزون','purple'),
      metric('التزام أول رد',percent(leads.firstResponseSlaRate),`${number(leads.slaBreaches)} تجاوز`,'cyan')
    ];
  }
  if(role==='training_manager'){
    return [
      metric('مجموعات نشطة',number(training.activeCourseRuns),'مفتوحة أو جارية','blue'),
      metric('جلسات 7 أيام',number(training.upcomingSessions),'قادمة','purple'),
      metric('متدربون نشطون',number(training.activeEnrollments),'مسجلون ومؤكدون','green'),
      metric('نسبة الحضور',percent(training.attendanceRate),'حاضر أو متأخر','cyan'),
      metric('متوسط التقييم',percent(training.averageAssessmentRate),'لكل النتائج المسجلة','amber'),
      metric('شهادات الشهر',number(training.issuedCertificatesThisMonth),`${number(training.failedAutomationJobs)} إخفاق آلي`,'pink')
    ];
  }
  return [
    metric('مهام اليوم',number(personal.tasksToday),'المطلوب إنجازه اليوم','blue'),
    metric('مهام مفتوحة',number(personal.openTasks),'إجمالي مهامك','purple'),
    metric('مهام متأخرة',number(personal.overdueTasks),'تحتاج تدخلًا','amber'),
    metric('مكتمل هذا الشهر',number(personal.completedThisMonth),'إنجازاتك المسجلة','green')
  ];
}

function quickActions(slug,permissions){
  const allowed=new Set(permissions||[]);
  const actions=[
    ['إدارة مهام اليوم',`/tenant/${slug}/tasks`,'tenant.work.read'],
    ['فتح مسار المبيعات',`/tenant/${slug}/sales`,'tenant.crm.read'],
    ['مركز التقارير',`/tenant/${slug}/reports`,'tenant.workspace.read'],
    ['تقارير المكالمات',`/tenant/${slug}/call-reports`,'tenant.crm.read'],
    ['استقبال وتوزيع العملاء',`/tenant/${slug}/lead-queue`,'tenant.leads.read'],
    ['التسجيل والقبول',`/tenant/${slug}/admissions`,'tenant.admissions.read'],
    ['الأهداف والحوافز',`/tenant/${slug}/incentives`,'tenant.incentives.read']
  ];
  return actions.filter(([, ,permission])=>allowed.has(permission));
}

function MetricCards({items}){
  const hasFeatured=items.some(item=>item.featured);
  return <section
    className={`${styles.metrics} ${hasFeatured?styles.featuredMetrics:''}`}
    aria-label="مؤشرات الأداء"
  >
    {items.map(item=><article
      className={[
        styles.metric,
        styles[item.tone]||'',
        item.featured?styles.metricFeatured:''
      ].filter(Boolean).join(' ')}
      key={item.label}
    >
      <span>{item.label}</span>
      <b>{item.value}</b>
      <small>{item.note}</small>
    </article>)}
  </section>;
}

function Trend({daily=[]}){
  const max=Math.max(1,...daily.flatMap(day=>[
    Number(day.activities)||0,
    Number(day.calls)||0,
    Number(day.paid)||0
  ]));
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>آخر 7 أيام</span><h3>اتجاه النشاط اليومي</h3></div>
      <div className={styles.legend}>
        <i className={styles.activities}/> أنشطة
        <i className={styles.calls}/> مكالمات
        <i className={styles.paid}/> دفع
      </div>
    </header>
    <div className={styles.chart}>
      {daily.map(day=><div className={styles.chartDay} key={day.date}>
        <div className={styles.bars} aria-label={`${day.date}: ${day.activities} نشاط، ${day.calls} مكالمة، ${day.paid} دفع`}>
          <i className={styles.activities} style={{height:`${Math.max(4,(Number(day.activities)||0)/max*100)}%`}}/>
          <i className={styles.calls} style={{height:`${Math.max(4,(Number(day.calls)||0)/max*100)}%`}}/>
          <i className={styles.paid} style={{height:`${Math.max(4,(Number(day.paid)||0)/max*100)}%`}}/>
        </div>
        <small>{new Intl.DateTimeFormat('ar-EG',{weekday:'short'}).format(new Date(`${day.date}T12:00:00`))}</small>
      </div>)}
      {!daily.length&&<div className={styles.empty}>ستظهر حركة الأداء بعد تسجيل أول نشاط.</div>}
    </div>
  </article>;
}

function TaskList({tasks=[],slug}){
  const open=tasks
    .filter(task=>OPEN_TASK_STATUSES.has(task.status))
    .sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))
    .slice(0,6);
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>الأولوية الآن</span><h3>المهام الأقرب</h3></div>
      <Link href={`/tenant/${slug}/tasks`}>كل المهام</Link>
    </header>
    <div className={styles.list}>
      {open.map(task=><div className={styles.listRow} key={task.id}>
        <div>
          <b>{task.title}</b>
          <small>{task.contactName||task.contactCourseName||'مهمة تشغيلية'}</small>
        </div>
        <time className={new Date(task.dueAt)<new Date()?styles.late:''}>
          {when(task.dueAt)}
        </time>
      </div>)}
      {!open.length&&<div className={styles.empty}>لا توجد مهام مفتوحة حاليًا.</div>}
    </div>
  </article>;
}

function CallsPanel({telephony={},slug,showSettings=false}){
  const configured=Boolean(telephony.configured);
  const mapped=Boolean(telephony.mapped);
  return <article className={`${styles.panel} ${styles.callsPanel}`}>
    <header className={styles.panelHead}>
      <div><span>Yeastar P550</span><h3>تحليل المكالمات</h3></div>
      {configured&&mapped&&<Link href={`/tenant/${slug}/call-reports`}>التقرير الكامل</Link>}
    </header>
    {!configured?<div className={styles.integrationState}>
      <i>☎</i>
      <div><b>السنترال غير مربوط بعد</b><p>أدخل بيانات API واختبر الاتصال لتظهر مؤشرات المكالمات.</p></div>
      {showSettings&&<Link href={`/tenant/${slug}/settings`}>إعداد Yeastar</Link>}
    </div>:!mapped?<div className={styles.integrationState}>
      <i>⇄</i>
      <div><b>لم تُربط تحويلتك بملفك الوظيفي</b><p>يحتاج مدير المنشأة إلى اختيار الموظف المقابل لكل تحويلة.</p></div>
      {showSettings&&<Link href={`/tenant/${slug}/settings`}>ربط التحويلات</Link>}
    </div>:<div className={styles.callStats}>
      <div><span>إجمالي المكالمات</span><b>{number(telephony.totalCalls)}</b></div>
      <div><span>نسبة الرد</span><b>{percent(telephony.answerRate)}</b></div>
      <div><span>فائتة</span><b>{number(telephony.missedCalls)}</b></div>
      <div><span>وقت الحديث</span><b>{duration(telephony.talkSeconds)}</b></div>
      <div><span>متوسط المكالمة</span><b>{duration(telephony.averageTalkSeconds)}</b></div>
      <div><span>التحويلة</span><b>{telephony.extensions||'—'}</b></div>
    </div>}
  </article>;
}

function TeamTable({team=[],slug}){
  return <article className={`${styles.panel} ${styles.teamPanel}`}>
    <header className={styles.panelHead}>
      <div><span>تفاصيل الفريق</span><h3>أداء الموظفين</h3></div>
      <small>{number(team.length)} موظفين ظاهرين وفق صلاحيتك</small>
    </header>
    <div className={styles.tableWrap}>
      <table>
        <thead><tr>
          <th>الموظف</th>
          <th>التحويلة</th>
          <th>عملاء نشطون</th>
          <th>أنشطة اليوم</th>
          <th>دفع الشهر</th>
          <th>المكالمات</th>
          <th>نسبة الرد</th>
          <th>مهام متأخرة</th>
        </tr></thead>
        <tbody>
          {team.map(member=><tr key={member.staffId}>
            <td><Link href={`/tenant/${slug}/reports/employees/${member.staffId}`}><b>{member.name}</b><small>{member.jobTitle||ROLE_LABELS[member.roleKey]||'موظف'}</small></Link></td>
            <td>{member.extension||<span className={styles.muted}>غير مربوط</span>}</td>
            <td>{number(member.activeLeads)}</td>
            <td>{number(member.activitiesToday)}</td>
            <td><strong>{number(member.paidThisMonth)}</strong></td>
            <td>{number(member.totalCalls)}</td>
            <td>{percent(member.answerRate)}</td>
            <td><span className={member.overdueTasks?styles.badgeLate:styles.badgeOk}>{number(member.overdueTasks)}</span></td>
          </tr>)}
          {!team.length&&<tr><td colSpan="8"><div className={styles.empty}>لا توجد بيانات فريق متاحة لهذا الدور.</div></td></tr>}
        </tbody>
      </table>
    </div>
  </article>;
}

function SourcesPanel({sources=[]}){
  const max=Math.max(1,...sources.map(item=>Number(item.total)||0));
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>جودة القنوات</span><h3>مصادر العملاء والتحويل</h3></div>
    </header>
    <div className={styles.sourceList}>
      {sources.map(item=><div key={item.source}>
        <div><b>{item.source}</b><span>{number(item.total)} عميل · {percent(item.conversionRate)} تحويل</span></div>
        <i><span style={{width:`${(Number(item.total)||0)/max*100}%`}}/></i>
      </div>)}
      {!sources.length&&<div className={styles.empty}>لا توجد بيانات مصادر كافية للتحليل بعد.</div>}
    </div>
  </article>;
}

function normalizedPercent(value){
  return Math.min(100,Math.max(0,Number(value)||0));
}

function ratioPercent(value,total){
  const denominator=Number(total)||0;
  if(!denominator)return 0;
  return normalizedPercent((Number(value)||0)/denominator*100);
}

function taskSnapshot(tasks=[]){
  const now=Date.now();
  const open=tasks.filter(task=>OPEN_TASK_STATUSES.has(task.status));
  return {
    open:open.length,
    overdue:open.filter(task=>{
      const due=new Date(task.dueAt).getTime();
      return Number.isFinite(due)&&due<now;
    }).length,
    completed:tasks.filter(task=>task.status==='completed').length
  };
}

function SystemPillars({dashboard,marketing,operations,slug,canReadMarketing}){
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const calls=dashboard.telephony||{};
  const training=dashboard.training||{};
  const marketingSummary=marketing?.summary||{};
  const tasks=taskSnapshot(operations?.tasks||[]);
  const distributedThisMonth=Number(
    sales.distributedThisMonth??sales.assignmentsThisMonth
  )||0;
  const paidFromDistributedThisMonth=Number(
    sales.paidFromDistributedThisMonth
  )||0;
  const closingRate=distributedThisMonth>0
    ?normalizedPercent(sales.closingRate??sales.conversionRate)
    :null;
  const qualifiedLeads=Number(sales.qualifiedLeads)||0;
  const qualifiedValueMinor=Number(sales.qualifiedValueMinor)||0;
  const hasForecast=distributedThisMonth>0
    &&sales.expectedRevenueMinor!=null;
  const closingRateLabel=closingRate==null?'—':percent(closingRate);
  const pillars=[
    {
      key:'sales',icon:'↗',title:'نسبة التقفيل',tone:'blue',
      href:`/tenant/${slug}/sales`,
      headline:closingRateLabel,
      headlineLabel:'طلاب دفعوا ÷ أرقام موزعة هذا الشهر',
      stats:[
        ['أرقام موزعة',number(distributedThisMonth)],
        ['طلاب دفعوا منها',number(paidFromDistributedThisMonth)],
        ['مؤهلون حاليًا',number(qualifiedLeads)]
      ]
    },
    {
      key:'forecast',icon:'≈',title:'الإيراد المتوقع',tone:'emerald',
      href:`/tenant/${slug}/reports/sales`,
      headline:hasForecast
        ?moneyMinor(sales.expectedRevenueMinor)
        :'—',
      headlineLabel:hasForecast
        ?'توقع محافظ للعملاء المؤهلين حاليًا'
        :'يحتاج عينة توزيع لحساب توقع موثوق',
      stats:[
        ['عملاء مؤهلون',number(qualifiedLeads)],
        ['قيمتهم الحالية',moneyMinor(qualifiedValueMinor)],
        ['المعادلة',closingRate==null
          ?'بانتظار نسبة التقفيل'
          :`${closingRateLabel} × القيمة`]
      ]
    },
    ...(canReadMarketing?[{
      key:'marketing',icon:'◎',title:'الإعلانات',tone:'violet',
      href:`/tenant/${slug}/marketing`,
      headline:marketing
        ?moneyMinorCurrency(
          marketingSummary.spendMinor,
          marketingSummary.currency
        )
        :'—',
      headlineLabel:marketing?'إنفاق آخر 30 يومًا':'البيانات غير متاحة الآن',
      stats:marketing?[
        ['نتائج المنصات',number(marketingSummary.platformLeads)],
        ['مبيعات CRM',number(marketingSummary.sales)],
        ['ROAS موثّق',Number(marketingSummary.spendMinor)>0
          ?ratio(marketingSummary.roas)
          :'—']
      ]:[
        ['حالة البيانات','تعذر التحميل'],
        ['الأرقام البديلة','غير معروضة'],
        ['الإجراء','فتح المركز']
      ]
    }]:[]),
    {
      key:'calls',icon:'☎',title:'المكالمات',tone:'cyan',
      href:`/tenant/${slug}/call-reports`,
      headline:number(calls.totalCalls),headlineLabel:'مكالمة هذا الشهر',
      stats:[
        ['نسبة الرد',percent(calls.answerRate)],
        ['مكالمات فائتة',number(calls.missedCalls)],
        ['وقت الحديث',duration(calls.talkSeconds)]
      ]
    },
    {
      key:'training',icon:'◫',title:'الطلاب والتدريب',tone:'green',
      href:`/tenant/${slug}/admissions`,
      headline:number(training.activeEnrollments),headlineLabel:'طالبًا ومتدربًا نشطًا',
      stats:[
        ['مجموعات نشطة',number(training.activeCourseRuns)],
        ['جلسات قادمة',number(training.upcomingSessions)],
        ['نسبة الحضور',percent(training.attendanceRate)]
      ]
    },
    {
      key:'operations',icon:'◆',title:'التشغيل والفريق',tone:'amber',
      href:`/tenant/${slug}/tasks`,
      headline:number(executive.activeStaff),headlineLabel:'موظفًا نشطًا',
      stats:[
        ['حسابات دخول',number(executive.activeAccounts)],
        ['مهام مفتوحة',number(tasks.open)],
        ['مهام متأخرة',number(tasks.overdue)]
      ]
    }
  ];

  return <section className={styles.systemSection} aria-label="خريطة أداء المنشأة">
    <header className={styles.sectionHeading}>
      <div><span>المنشأة في شاشة واحدة</span><h3>خريطة الأداء الشاملة</h3></div>
      <p>كل محور يعرض رقمًا تنفيذيًا ثم أهم ثلاث إشارات تشغيلية من مصدره الفعلي.</p>
    </header>
    <div className={`${styles.pillarGrid} ${
      pillars.length===5?styles.pillarGridFive:''
    }`}>
      {pillars.map(pillar=><article
        className={`${styles.pillar} ${styles[pillar.tone]||''}`}
        key={pillar.key}
      >
        <header className={styles.pillarHead}>
          <i aria-hidden="true">{pillar.icon}</i>
          <div><span>محور الأداء</span><h4>{pillar.title}</h4></div>
        </header>
        <div className={styles.pillarHeadline}>
          <b>{pillar.headline}</b><span>{pillar.headlineLabel}</span>
        </div>
        <dl>
          {pillar.stats.map(([label,value])=><div key={label}>
            <dt>{label}</dt><dd>{value}</dd>
          </div>)}
        </dl>
        <Link href={pillar.href}>فتح التفاصيل <span aria-hidden="true">←</span></Link>
      </article>)}
    </div>
  </section>;
}

function buildExecutiveActions(dashboard,marketing,operations){
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const calls=dashboard.telephony||{};
  const leads=dashboard.leadOperations||{};
  const training=dashboard.training||{};
  const marketingSummary=marketing?.summary||{};
  const tasks=taskSnapshot(operations?.tasks||[]);
  const actions=[];
  const add=(tone,title,note)=>actions.push({tone,title,note});

  if(Number(training.failedAutomationJobs)>0){
    add('urgent','تعطل في أتمتة التدريب',`${number(training.failedAutomationJobs)} عمليات آلية فشلت وتحتاج إعادة معالجة.`);
  }
  if(tasks.overdue>0){
    add('urgent','مهام تشغيلية متأخرة',`${number(tasks.overdue)} مهمة مفتوحة تجاوزت موعدها الحالي.`);
  }
  if(Number(sales.overdueFollowUps)>0){
    add('urgent','عملاء بلا متابعة في موعدهم',`${number(sales.overdueFollowUps)} عميلًا تجاوز موعد الإجراء التالي.`);
  }
  if(Number(executive.pendingPaymentVerification)>0){
    add('watch','مبالغ بانتظار التحقق',`${number(executive.pendingPaymentVerification)} حالة دفع تحتاج مراجعة قبل احتسابها كإيراد.`);
  }
  if(Number(executive.pendingAdmissions)>0){
    add('watch','طلبات قبول لم تُغلق',`${number(executive.pendingAdmissions)} طلب قبول ما زال معلّقًا أو قيد المراجعة.`);
  }
  if(Number(calls.missedCalls)>0){
    add('watch','مكالمات تحتاج استردادًا',`${number(calls.missedCalls)} مكالمة فائتة هذا الشهر وفق سجل Yeastar.`);
  }
  if(Number(leads.awaitingDistribution)>0){
    add('setup','بيانات جاهزة ولم تُوزع',`${number(leads.awaitingDistribution)} عميلًا صالحًا ما زال في قائمة الانتظار.`);
  }
  const inactiveAccounts=Math.max(
    0,
    (Number(executive.activeStaff)||0)-(Number(executive.activeAccounts)||0)
  );
  if(inactiveAccounts>0){
    add('setup','فجوة في حسابات الفريق',`${number(inactiveAccounts)} موظفين نشطين بلا حساب دخول نشط.`);
  }
  if(marketing&&Number(marketingSummary.spendMinor)>0){
    if(Number(marketingSummary.sales)<=0){
      add('watch','إنفاق إعلاني بلا مبيعات CRM موثقة','راجع الإسناد وربط العملاء قبل الحكم على العائد أو زيادة الميزانية.');
    }else if(Number(marketingSummary.roas)<1){
      add('watch','العائد الموثق أقل من نقطة التعادل',`ROAS الموثق ${ratio(marketingSummary.roas)} خلال آخر 30 يومًا.`);
    }
  }
  if(!actions.length){
    add('positive','لا توجد اختناقات ظاهرة الآن','المصادر المتاحة لا تعرض مهامًا متأخرة أو حالات تشغيل معلّقة تحتاج تدخلًا فوريًا.');
  }
  return actions.slice(0,6);
}

function ExecutiveActionCenter({dashboard,marketing,operations}){
  const actions=buildExecutiveActions(dashboard,marketing,operations);
  return <section className={styles.actionCenter} aria-label="أهم ما يحتاج إجراء">
    <header className={styles.actionCenterHead}>
      <div><span>من الأرقام إلى القرار</span><h3>أهم ما يحتاج إجراء الآن</h3></div>
      <small>قواعد واضحة تعتمد على الحالات الفعلية، بلا أرقام تقديرية</small>
    </header>
    <div className={styles.actionList}>
      {actions.map((item,index)=><article
        className={`${styles.actionItem} ${styles[item.tone]||''}`}
        key={`${item.title}-${index}`}
      >
        <i aria-hidden="true">{index+1}</i>
        <div><b>{item.title}</b><p>{item.note}</p></div>
        <span>{item.tone==='urgent'
          ?'عاجل'
          :item.tone==='watch'
            ?'مراجعة'
            :item.tone==='setup'
              ?'تشغيل'
              :'مستقر'}</span>
      </article>)}
    </div>
  </section>;
}

function marketingVerdict(summary){
  const spend=Number(summary.spendMinor)||0;
  const platformLeads=Number(summary.platformLeads)||0;
  const verifiedSales=Number(summary.sales)||0;
  const verifiedRoas=Number(summary.roas);
  if(!spend){
    return {tone:'neutral',label:'بانتظار بيانات كافية',text:'لا يوجد إنفاق مسجل في الفترة الحالية؛ راجع المزامنة أو نطاق التاريخ داخل مركز الحملات.'};
  }
  if(verifiedSales>0&&verifiedRoas>=1){
    return {tone:'good',label:'العائد الموثق فوق نقطة التعادل',text:'هناك مبيعات فعلية منسوبة تغطي الإنفاق. راقب تكلفة الاكتساب قبل توسيع الميزانية.'};
  }
  if(verifiedSales>0&&verifiedRoas<1){
    return {tone:'risk',label:'العائد الموثق دون نقطة التعادل',text:'الإيراد الموثق أقل من الإنفاق خلال الفترة؛ راجع الحملات والإسناد قبل زيادة الميزانية.'};
  }
  if(platformLeads>0){
    return {tone:'watch',label:'نتائج المنصات لم تتحول إلى مبيعات موثقة',text:'المنصات تسجل نتائج، لكن CRM لا يثبت مبيعات منسوبة بعد. افحص الربط والتتبع ومسار المتابعة.'};
  }
  return {tone:'risk',label:'إنفاق دون نتائج مسجلة',text:'يوجد إنفاق بلا نتائج حتى على مستوى المنصة؛ راجع التتبع والاستهداف فورًا.'};
}

function MarketingPulse({marketing,slug,canRead}){
  if(!canRead)return null;
  if(!marketing){
    return <article className={`${styles.panel} ${styles.marketingPulse}`}>
      <header className={styles.panelHead}>
        <div><span>الإعلانات والإسناد</span><h3>نبض الحملات</h3></div>
        <Link href={`/tenant/${slug}/marketing`}>فتح مركز الحملات</Link>
      </header>
      <div className={styles.integrationState}>
        <i>◎</i>
        <div><b>تعذر تحميل بيانات الإعلانات الموثوقة</b><p>لم نعرض أرقامًا صفرية بديلة. افتح مركز الحملات لمراجعة الربط أو حالة الإضافة.</p></div>
      </div>
    </article>;
  }

  const summary=marketing.summary||{};
  const providers=marketing.providers||[];
  const campaigns=marketing.campaigns||[];
  const connected=providers.filter(provider=>
    ['active','degraded'].includes(provider.connection?.status)
  ).length;
  const topCampaign=campaigns.slice().sort((a,b)=>
    (Number(b.sales)||0)-(Number(a.sales)||0)
    ||(Number(b.platformConversions)||0)-(Number(a.platformConversions)||0)
    ||(Number(b.platformLeads)||0)-(Number(a.platformLeads)||0)
  )[0]||null;
  const verdict=marketingVerdict(summary);
  const currency=summary.currency||'SAR';
  const cards=[
    ['الإنفاق',moneyMinorCurrency(summary.spendMinor,currency),'من بيانات المنصات'],
    ['نتائج المنصات',number(summary.platformLeads),'قبل التحقق داخل CRM'],
    ['عملاء CRM',number(summary.leads),'عملاء منسوبون وموثقون'],
    ['مبيعات موثقة',number(summary.sales),'مدفوعات فعلية منسوبة'],
    ['إيراد موثق',moneyMinorCurrency(summary.revenueMinor,currency),'بعد الإسناد والمرتجعات'],
    ['ROAS موثّق',Number(summary.spendMinor)>0?ratio(summary.roas):'—','إيراد CRM ÷ الإنفاق']
  ];

  return <article className={`${styles.panel} ${styles.marketingPulse}`}>
    <header className={styles.panelHead}>
      <div><span>آخر 30 يومًا</span><h3>نبض الإعلانات والإسناد</h3></div>
      <Link href={`/tenant/${slug}/marketing`}>التحليل الكامل</Link>
    </header>
    <div className={styles.marketingBody}>
      <div className={styles.marketingMetrics}>
        {cards.map(([label,value,note])=><div key={label}>
          <span>{label}</span><b>{value}</b><small>{note}</small>
        </div>)}
      </div>
      <aside className={`${styles.marketingVerdict} ${styles[verdict.tone]||''}`}>
        <span>القراءة التنفيذية</span>
        <b>{verdict.label}</b>
        <p>{verdict.text}</p>
        <footer>
          <small>{number(connected)} منصة متصلة</small>
          <small>{topCampaign
            ?`الأعلى نتائج: ${topCampaign.campaignName||topCampaign.name||topCampaign.campaign||'حملة مسجلة'}`
            :'لا توجد حملة قابلة للمقارنة بعد'}</small>
        </footer>
      </aside>
    </div>
  </article>;
}

function ExecutiveHealth({dashboard}){
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const calls=dashboard.telephony||{};
  const leads=dashboard.leadOperations||{};
  const accountRate=ratioPercent(
    executive.activeAccounts,
    executive.activeStaff
  );
  const responseRate=Number(
    leads.firstResponseSlaRate??sales.firstResponseSlaRate
  )||0;
  const responseMinutes=Number(
    leads.averageFirstResponseMinutes??sales.averageFirstResponseMinutes
  )||0;
  const items=[
    {
      label:'تفعيل حسابات الفريق',
      value:accountRate,
      note:`${number(executive.activeAccounts)} من ${number(executive.activeStaff)} موظف`
    },
    {
      label:'الرد على المكالمات',
      value:normalizedPercent(calls.answerRate),
      note:`${number(calls.answeredCalls)} من ${number(calls.totalCalls)} مكالمة`
    },
    {
      label:'الالتزام بأول متابعة',
      value:normalizedPercent(responseRate),
      note:responseMinutes
        ?`${number(responseMinutes)} دقيقة متوسط أول رد`
        :'لا توجد مدة استجابة مسجلة'
    },
    {
      label:'تحويل العملاء للدفع',
      value:normalizedPercent(sales.conversionRate),
      note:`${number(sales.paidThisMonth)} تسجيلًا محققًا هذا الشهر`
    }
  ];

  return <section className={styles.health} aria-label="صحة المنشأة">
    <header className={styles.healthHead}>
      <div>
        <span>قراءة إدارية موحّدة</span>
        <h3>صحة المنشأة</h3>
      </div>
      <p>النسب محسوبة مباشرة من الحسابات والمبيعات والمكالمات المسجلة.</p>
    </header>
    <div className={styles.healthGrid}>
      {items.map(item=><article key={item.label}>
        <div>
          <span>{item.label}</span>
          <b>{percent(Math.round(item.value))}</b>
        </div>
        <i
          role="progressbar"
          aria-label={item.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.value)}
        >
          <span style={{width:`${item.value}%`}}/>
        </i>
        <small>{item.note}</small>
      </article>)}
    </div>
  </section>;
}

function ReadinessAlerts({role,dashboard}){
  const alerts=[];
  const calls=dashboard.telephony||{};
  const personal=dashboard.personal||{};
  const leads=dashboard.leadOperations||{};
  const training=dashboard.training||{};
  if((SALES_ROLES.has(role)||role==='customer_service')&&!calls.configured){
    alerts.push('ربط Yeastar غير مفعّل؛ مؤشرات المكالمات ستبقى فارغة حتى أول مزامنة.');
  }else if((SALES_ROLES.has(role)||role==='customer_service')&&!calls.mapped){
    alerts.push('Yeastar متصل، لكن تحويلة هذا الموظف لم تُربط بملفه الوظيفي.');
  }
  if(Number(personal.overdueTasks)>0){
    alerts.push(`هناك ${number(personal.overdueTasks)} مهمة متأخرة تحتاج معالجة.`);
  }
  if(DATA_ROLES.has(role)&&Number(leads.slaBreaches)>0){
    alerts.push(`${number(leads.slaBreaches)} عميل تجاوز مهلة أول متابعة.`);
  }
  if(role==='training_manager'&&Number(training.failedAutomationJobs)>0){
    alerts.push(`${number(training.failedAutomationJobs)} رسالة تدريب آلية فشلت وتحتاج إعادة معالجة.`);
  }
  if(!alerts.length)return null;
  return <section className={styles.alerts} aria-label="تنبيهات الأداء">
    {alerts.map(alert=><div key={alert}><span>!</span><p>{alert}</p></div>)}
  </section>;
}

export default function RoleDashboard({
  slug,
  dashboard,
  operations,
  marketing=null,
  canReadMarketing=false,
  permissions=[],
  fallbackRoleKey='tenant_user'
}){
  const role=dashboard?.viewer?.roleKey||fallbackRoleKey||'tenant_user';
  const copy=ROLE_COPY[role]||ROLE_COPY.tenant_user;
  const viewer=dashboard?.viewer||{};
  const actions=quickActions(slug,permissions);

  if(dashboard?.unavailable){
    return <div className={styles.dashboard}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </section>
      <div className={styles.fallbackNote} role="alert">
        تعذر تحميل مؤشرات الأداء الموثوقة الآن. لم نعرض أرقامًا بديلة حتى لا تظهر بيانات غير دقيقة؛ أعد المحاولة بعد قليل.
      </div>
      <TaskList tasks={operations?.tasks||[]} slug={slug}/>
    </div>;
  }

  const metrics=roleMetrics(
    role,
    dashboard||{},
    marketing,
    canReadMarketing
  );
  const showCalls=SALES_ROLES.has(role)
    ||EXECUTIVE_ROLES.has(role)
    ||role==='customer_service';
  const showTeam=Boolean(viewer.viewTeam)&&(
    SALES_ROLES.has(role)||EXECUTIVE_ROLES.has(role)
  );
  const showSources=DATA_ROLES.has(role)
    ||role==='sales_manager'
    ||EXECUTIVE_ROLES.has(role);
  const showMarketing=canReadMarketing&&(
    EXECUTIVE_ROLES.has(role)||role==='data_analyst'
  );

  return <div className={styles.dashboard}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
        <div className={styles.identity}>
          <b>{viewer.name||'مستخدم ماركتون'}</b>
          <i>•</i>
          <span>{viewer.jobTitle||viewer.roleLabel||ROLE_LABELS[role]||'مستخدم المنشأة'}</span>
          <i>•</i>
          <small>{viewer.viewTeam?'نطاق الفريق':'نطاقي الشخصي فقط'}</small>
        </div>
      </div>
      <div className={styles.heroAside}>
        <span>آخر تحديث</span>
        <b>{when(dashboard?.generatedAt)}</b>
        <small>تتحدث الأرقام تلقائيًا من بيانات التشغيل</small>
      </div>
    </section>

    <ReadinessAlerts role={role} dashboard={dashboard||{}}/>
    <MetricCards items={metrics}/>
    {EXECUTIVE_ROLES.has(role)&&<SystemPillars
      dashboard={dashboard||{}}
      marketing={marketing}
      operations={operations}
      slug={slug}
      canReadMarketing={canReadMarketing}
    />}
    {EXECUTIVE_ROLES.has(role)&&<ExecutiveActionCenter
      dashboard={dashboard||{}}
      marketing={marketing}
      operations={operations}
    />}
    {EXECUTIVE_ROLES.has(role)&&<ExecutiveHealth
      dashboard={dashboard||{}}
    />}

    <section className={styles.actions} aria-label="إجراءات سريعة">
      <div><span>إجراءات مناسبة لدورك</span><b>ابدأ من هنا</b></div>
      <nav>
        {actions.slice(0,5).map(([label,href])=><Link key={href} href={href}>{label}</Link>)}
      </nav>
    </section>

    <section className={styles.grid}>
      <Trend daily={dashboard?.daily||[]}/>
      <TaskList tasks={operations?.tasks||[]} slug={slug}/>
    </section>

    {showMarketing&&<MarketingPulse
      marketing={marketing}
      slug={slug}
      canRead={canReadMarketing}
    />}

    {showCalls&&<CallsPanel
      telephony={dashboard?.telephony||{}}
      slug={slug}
      showSettings={permissions.includes('tenant.settings.manage')}
    />}

    {showSources&&<section className={styles.grid}>
      <SourcesPanel sources={dashboard?.sources||[]}/>
      <article className={styles.panel}>
        <header className={styles.panelHead}>
          <div><span>سرعة التشغيل</span><h3>الاستجابة والتوزيع</h3></div>
        </header>
        <div className={styles.callStats}>
          <div><span>متوسط أول رد</span><b>{number((dashboard?.leadOperations||{}).averageFirstResponseMinutes||(dashboard?.sales||{}).averageFirstResponseMinutes)} د</b></div>
          <div><span>الالتزام بالمهلة</span><b>{percent((dashboard?.leadOperations||{}).firstResponseSlaRate||(dashboard?.sales||{}).firstResponseSlaRate)}</b></div>
          <div><span>بانتظار التوزيع</span><b>{number((dashboard?.leadOperations||{}).awaitingDistribution)}</b></div>
          <div><span>تجاوزات المهلة</span><b>{number((dashboard?.leadOperations||{}).slaBreaches)}</b></div>
        </div>
      </article>
    </section>}

    {showTeam&&<TeamTable team={dashboard?.team||[]} slug={slug}/>}

    {role==='sales_user'&&<section className={styles.personalStrip}>
      <div><span>حافز مستحق أو قيد المراجعة</span><b>{money((dashboard?.personal||{}).pendingIncentive)}</b></div>
      <div><span>حافز مدفوع هذا الشهر</span><b>{money((dashboard?.personal||{}).paidIncentiveThisMonth)}</b></div>
      <div><span>المهام المكتملة في موعدها</span><b>{number((dashboard?.personal||{}).onTimeThisMonth)}</b></div>
      <Link href={`/tenant/${slug}/incentives`}>تفاصيل الحوافز</Link>
    </section>}

  </div>;
}
