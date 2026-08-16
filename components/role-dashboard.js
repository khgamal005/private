import Link from 'next/link';
import {REPORT_DATE_PRESETS} from '../lib/reporting';
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

function moneyMinorCurrency(value,currency='SAR'){
  const normalized=/^[A-Z]{3}$/.test(String(currency||'').toUpperCase())
    ?String(currency).toUpperCase()
    :'SAR';
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:normalized,
    minimumFractionDigits:2,
    maximumFractionDigits:2
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

function when(value,timeZone){
  if(!value)return 'الآن';
  const options={
    day:'numeric',month:'short',hour:'numeric',minute:'2-digit',
    ...(timeZone?{timeZone}:{})
  };
  try{
    return new Intl.DateTimeFormat('ar-EG',options).format(new Date(value));
  }catch{
    return new Intl.DateTimeFormat('ar-EG',{
      day:'numeric',month:'short',hour:'numeric',minute:'2-digit'
    }).format(new Date(value));
  }
}

function periodLabel(period){
  const from=String(period?.from||'');
  const to=String(period?.to||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(to)){
    return 'النطاق الزمني غير متاح';
  }
  const fromDate=new Date(`${from}T12:00:00Z`);
  const toDate=new Date(`${to}T12:00:00Z`);
  const day=new Intl.DateTimeFormat('ar-EG',{day:'numeric'});
  const monthDay=new Intl.DateTimeFormat('ar-EG',{
    day:'numeric',month:'long'
  });
  const full=new Intl.DateTimeFormat('ar-EG',{
    day:'numeric',month:'long',year:'numeric'
  });
  const label=from===to
    ?full.format(toDate)
    :from.slice(0,7)===to.slice(0,7)
      ?`${day.format(fromDate)}–${full.format(toDate)}`
      :from.slice(0,4)===to.slice(0,4)
        ?`${monthDay.format(fromDate)}–${full.format(toDate)}`
        :`${full.format(fromDate)}–${full.format(toDate)}`;
  const timezone=period?.timeZone||period?.timezone;
  const timezoneLabel=timezone==='Asia/Riyadh'
    ?'بتوقيت الرياض'
    :timezone
      ?`بتوقيت ${timezone}`
      :'';
  return `${label}${timezoneLabel?` · ${timezoneLabel}`:''}`;
}

function rangeHref(path,period){
  const from=String(period?.from||'');
  const to=String(period?.to||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(to))return path;
  const query=new URLSearchParams({from,to});
  return `${path}?${query.toString()}`;
}

function marketingDataNeedsAttention(marketing){
  const dataHealth=marketing?.dataHealth||{};
  return marketing?.featureEnabled===false
    ||Number(dataHealth.currencyMismatches)>0
    ||Number(dataHealth.staleConnections)>0;
}

function commercialReturn(woo,marketing){
  const marketingSummary=marketing?.summary||{};
  const totals=woo?.totals||{};
  const wooCurrency=String(woo?.currency||'').toUpperCase();
  const marketingCurrency=String(
    marketingSummary?.currency||''
  ).toUpperCase();
  const netMinor=Number(totals.netSalesMinor);
  const spendMinor=Number(marketingSummary?.spendMinor);
  const digits=Math.min(4,Math.max(0,Number(woo?.minorDigits)||0));
  const rangeFrom=String(marketing?.range?.from||'');
  const rangeTo=String(marketing?.range?.to||'');
  const wooFrom=String(woo?.range?.from||'');
  const wooTo=String(woo?.range?.to||'');
  const sameRange=/^\d{4}-\d{2}-\d{2}$/.test(rangeFrom)
    &&/^\d{4}-\d{2}-\d{2}$/.test(rangeTo)
    &&rangeFrom===wooFrom
    &&rangeTo===wooTo;
  if(!woo?.available
    ||woo?.stale
    ||marketingDataNeedsAttention(marketing)
    ||!sameRange
    ||!Number.isFinite(netMinor)
    ||!Number.isFinite(spendMinor)
    ||spendMinor<=0
    ||!wooCurrency
    ||wooCurrency!==marketingCurrency){
    return null;
  }
  return (netMinor/(10**digits))/(spendMinor/100);
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
    const trainingAvailable=executive.trainingMonthAvailable!==false;
    const hasWooRevenue=woo.available
      &&Number.isFinite(Number(wooTotals.netSalesMinor))
      &&wooTotals.netSalesMinor!=null;
    const wooOrderCount=Number(wooTotals.orderCount)||0;
    const averageOrderMinor=hasWooRevenue&&wooOrderCount>0
      ?Math.round(Number(wooTotals.netSalesMinor)/wooOrderCount)
      :null;
    if(woo.connected){
      items.push(metric(
        'صافي مبيعات WooCommerce خلال الفترة',
        hasWooRevenue?wooMoney(wooTotals.netSalesMinor):'غير متاح للفترة',
        hasWooRevenue
          ?`${number(wooTotals.orderCount)} طلبًا · `
            +`الإجمالي ${wooMoney(wooTotals.grossSalesMinor)} · `
            +`الخصومات ${wooMoney(wooTotals.couponsMinor)}`
            +`${Number(wooTotals.returnsMinor)>0
              ?` · المرتجعات ${wooMoney(wooTotals.returnsMinor)}`
              :''}`
            +`${averageOrderMinor!=null
              ?` · متوسط الطلب ${wooMoney(averageOrderMinor)}`
              :''}`
            +`${woo.stale?' · البيانات تحتاج مزامنة حديثة':''}`
          :woo.rangeAvailable===false
            ?'لا توجد نسخة رسمية محفوظة من WooCommerce لهذا النطاق؛ لم نعرض رقم الشهر الحالي مكانها.'
          :woo.error
            ?'تعذر جلب تقرير WooCommerce الرسمي في آخر محاولة؛ راجع صلاحيات Analytics ثم أعد الاختبار.'
            :'سيظهر رقم WooCommerce الرسمي بعد اكتمال مزامنة تشمل الطلبات.',
        hasWooRevenue?'green':'amber',
        true
      ));
    }
    if(canReadMarketing){
      const marketingDegraded=marketingDataNeedsAttention(marketing);
      const hasMarketing=Boolean(marketing)
        &&marketingSummary.spendMinor!=null
        &&Number.isFinite(Number(marketingSummary.spendMinor));
      const returnValue=commercialReturn(woo,marketing);
      items.push(metric(
        marketingDegraded
          ?'الإنفاق الإعلاني المسجل خلال الفترة'
          :'الإنفاق الإعلاني الفعلي خلال الفترة',
        hasMarketing
          ?moneyMinorCurrency(
            marketingSummary.spendMinor,
            marketingSummary.currency
          )
          :'—',
        hasMarketing
          ?`${number(marketingSummary.platformLeads)} نتيجة حسب المنصات`
            +`${marketingDegraded?' · البيانات جزئية أو تحتاج مزامنة':''}`
            +`${returnValue!=null
              ?` · مضاعف المبيعات إلى الإنفاق ${ratio(returnValue)}`
              :''}`
          :'تعذر تحميل الإنفاق الفعلي؛ لم نعرض صفرًا بديلًا',
        hasMarketing&&!marketingDegraded?'purple':'amber',
        true
      ));
    }
    items.push(
      metric(
        'عملاء تأهلوا خلال الفترة',
        sales.monthAvailable===false
          ?'—'
          :number(sales.qualifiedEnteredThisMonth),
        sales.monthAvailable===false
          ?'لا تملك هذه الجلسة صلاحية قراءة مؤشرات CRM للفترة'
          :`${number(sales.qualifiedOpenFromMonth)} ما زالت مفتوحة · ${number(sales.qualifiedWonFromMonth)} أُغلقت ناجحًا`,
        'blue'
      ),
      metric(
        'عملاء وُزعوا خلال الفترة',
        sales.monthAvailable===false
          ?'—'
          :number(sales.distributedThisMonth),
        sales.monthAvailable===false
          ?'لا تملك هذه الجلسة صلاحية قراءة مؤشرات CRM للفترة'
          :`${number(sales.paidFromDistributedThisMonth)} دفعوا داخل الفترة · ${sales.closingRate==null?'—':percent(sales.closingRate)} تقفيل`,
        'cyan'
      ),
      metric(
        'دفعات التسجيل المؤكدة خلال الفترة',
        trainingAvailable
          ?moneyMinorCurrencyExact(
            executive.wonRevenueMinor,
            executive.revenueCurrency||'SAR',
            executive.revenueMinorDigits??2
          )
          :'—',
        trainingAvailable
          ?`${number(executive.verifiedAdmissionsThisMonth)} عميلًا بتحقق دفع داخل المنصة؛ منفصلة عن WooCommerce لمنع الازدواج`
          :'لا تملك هذه الجلسة صلاحية قراءة دفعات التسجيل والتدريب للفترة',
        trainingAvailable?'green':'amber'
      ),
      metric(
        'مكالمات خلال الفترة',
        number(calls.totalCalls),
        `${number(calls.answeredCalls)} مجاب عليها · ${percent(calls.answerRate)} نسبة الرد`,
        'cyan'
      ),
      metric(
        'إنجاز المهام المستحقة خلال الفترة',
        Number(executive.dueTasksThisMonthToDate)<=0
          ?'—'
          :percent(executive.taskCompletionRateThisMonth),
        `${number(executive.completedDueTasksThisMonthToDate)} مكتملة من ${number(executive.dueTasksThisMonthToDate)} مستحقة داخل النطاق`,
        'amber'
      ),
      metric(
        'عملاء جدد خلال الفترة',
        number(executive.newContactsThisMonth),
        `بعد استبعاد المؤرشف والمكرر · ${number(executive.activitiesThisMonth)} نشاط مبيعات خلال الفترة`,
        'pink'
      )
    );
    return items;
  }
  if(SALES_ROLES.has(role)){
    return [
      metric('عملاء قيد المتابعة',number(sales.activeLeads),'داخل مسارك الحالي','blue'),
      metric('مدفوعات مؤكدة هذا الشهر',number(sales.paidThisMonth),`${percent(sales.conversionRate)} تحويل · ${number(sales.pendingPaymentVerification)} قيد التحقق حاليًا`,'green'),
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
      metric('مهام اليوم',number(personal.tasksToday),`${number(personal.openTasks)} مفتوحة حاليًا`,'purple'),
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
      metric('شهادات الشهر',number(training.issuedCertificatesThisMonth),`${number(training.failedAutomationJobs)} إخفاق آلي حاليًا`,'pink')
    ];
  }
  return [
    metric('مهام اليوم',number(personal.tasksToday),'المطلوب إنجازه اليوم','blue'),
    metric('مهام مفتوحة',number(personal.openTasks),'إجمالي مهامك','purple'),
    metric('مهام متأخرة',number(personal.overdueTasks),'تحتاج تدخلًا','amber'),
    metric('مكتمل هذا الشهر',number(personal.completedThisMonth),'إنجازاتك المسجلة','green')
  ];
}

function quickActions(slug,permissions,period){
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
  return actions
    .filter(([, ,permission])=>allowed.has(permission))
    .map(([label,href,permission])=>[
      label,
      rangeHref(href,period),
      permission
    ]);
}

function DashboardDateFilter({slug,range,period}){
  const maxDate=period?.today||period?.to||range?.to;
  return <form
    className={styles.dateFilter}
    method="get"
    aria-label="تصفية لوحة القيادة حسب التاريخ"
  >
    <div className={styles.dateFilterIntro}>
      <span>نطاق التحليل</span>
      <b>خصص الفترة الزمنية</b>
      <small>يُعاد حساب المؤشرات والرسوم من مصادرها الفعلية.</small>
    </div>
    <div className={styles.datePresets} aria-label="فترات جاهزة">
      {REPORT_DATE_PRESETS.map(preset=><button
        key={preset.key}
        type="submit"
        name="period"
        value={preset.key}
        className={range?.period===preset.key?styles.activePreset:''}
        aria-pressed={range?.period===preset.key}
      >{preset.label}</button>)}
    </div>
    <div className={styles.dateInputs}>
      <label>
        <span>من تاريخ</span>
        <input
          type="date"
          name="from"
          defaultValue={range?.from}
          max={maxDate}
          required
        />
      </label>
      <span className={styles.dateArrow} aria-hidden="true">←</span>
      <label>
        <span>إلى تاريخ</span>
        <input
          type="date"
          name="to"
          defaultValue={range?.to}
          max={maxDate}
          required
        />
      </label>
      <button className={styles.applyDate} type="submit">تطبيق</button>
      <Link href={`/tenant/${encodeURIComponent(slug)}?period=this_month`}>
        إعادة الضبط
      </Link>
    </div>
    <p className={styles.dateFilterHint} role="status">
      <b>{periodLabel(period)}</b>
      <span>المهام الأقرب والتنبيهات والحالات المعلّقة تبقى لحظية حتى لا تختفي الأولويات الحالية.</span>
    </p>
  </form>;
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
      <b><bdi>{item.value}</bdi></b>
      <small>{item.note}</small>
    </article>)}
  </section>;
}

function ExecutiveMetricSection({items,period}){
  return <section
    className={styles.metricSection}
    aria-labelledby="month-performance-heading"
  >
    <header className={styles.metricSectionHead}>
      <div>
        <span>قراءة موحّدة للنطاق المختار</span>
        <h3 id="month-performance-heading">أداء الفترة المحددة</h3>
      </div>
      <p>{periodLabel(period)} · كل رقم محسوب بتوقيت المنشأة ومن مصدره الفعلي، دون استبدال البيانات غير المتاحة بأصفار.</p>
    </header>
    <MetricCards items={items}/>
  </section>;
}

function trendBuckets(rows=[],maxBuckets=14){
  if(rows.length<=maxBuckets)return rows.map(row=>({...row,label:null}));
  const size=Math.ceil(rows.length/maxBuckets);
  const buckets=[];
  for(let index=0;index<rows.length;index+=size){
    const items=rows.slice(index,index+size);
    const first=items[0];
    const last=items.at(-1);
    const short=value=>new Intl.DateTimeFormat('ar-EG',{
      day:'numeric',month:'short'
    }).format(new Date(`${value}T12:00:00Z`));
    const average=key=>Math.round(
      items.reduce((sum,item)=>sum+(Number(item[key])||0),0)
        /items.length*10
    )/10;
    buckets.push({
      date:first.date,
      label:items.length===1
        ?short(first.date)
        :`${short(first.date)}–${short(last.date)}`,
      activities:average('activities'),
      calls:average('calls'),
      paid:average('paid')
    });
  }
  return buckets;
}

function Trend({daily=[],period}){
  const from=String(period?.from||'');
  const to=String(period?.to||'');
  const scopedDaily=trendBuckets(daily.filter(day=>{
    const date=String(day.date||'');
    return (!/^\d{4}-\d{2}-\d{2}$/.test(from)||date>=from)
      &&(!/^\d{4}-\d{2}-\d{2}$/.test(to)||date<=to);
  }));
  const max=Math.max(1,...scopedDaily.flatMap(day=>[
    Number(day.activities)||0,
    Number(day.calls)||0,
    Number(day.paid)||0
  ]));
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>{periodLabel(period)}</span><h3>اتجاه الأداء خلال الفترة</h3></div>
      <div className={styles.legend}>
        <i className={styles.activities}/> أنشطة
        <i className={styles.calls}/> مكالمات
        <i className={styles.paid}/> دفع
      </div>
    </header>
    <div className={styles.chart}>
      {scopedDaily.map(day=><div className={styles.chartDay} key={day.date}>
        <div className={styles.bars} role="img" aria-label={`${day.date}: ${day.activities} نشاط، ${day.calls} مكالمة، ${day.paid} دفع`}>
          <i className={styles.activities} style={{height:`${Number(day.activities)>0?Math.max(4,Number(day.activities)/max*100):0}%`}}/>
          <i className={styles.calls} style={{height:`${Number(day.calls)>0?Math.max(4,Number(day.calls)/max*100):0}%`}}/>
          <i className={styles.paid} style={{height:`${Number(day.paid)>0?Math.max(4,Number(day.paid)/max*100):0}%`}}/>
        </div>
        <small>{day.label||new Intl.DateTimeFormat('ar-EG',{weekday:'short'}).format(new Date(`${day.date}T12:00:00Z`))}</small>
      </div>)}
      {!scopedDaily.length&&<div className={styles.empty}>ستظهر حركة الأداء بعد تسجيل أول نشاط.</div>}
    </div>
  </article>;
}

function TaskList({tasks=[],slug,period=null}){
  const open=tasks
    .filter(task=>OPEN_TASK_STATUSES.has(task.status))
    .sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))
    .slice(0,6);
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>الأولوية الآن</span><h3>المهام الأقرب</h3></div>
      <Link href={rangeHref(`/tenant/${slug}/tasks`,period)}>كل المهام</Link>
    </header>
    <div className={styles.list}>
      {open.map(task=><div className={styles.listRow} key={task.id}>
        <div>
          <b>{task.title}</b>
          <small>{task.contactName||task.contactCourseName||'مهمة تشغيلية'}</small>
        </div>
        <time className={new Date(task.dueAt)<new Date()?styles.late:''}>
          {when(task.dueAt,period?.timeZone||period?.timezone)}
        </time>
      </div>)}
      {!open.length&&<div className={styles.empty}>لا توجد مهام مفتوحة حاليًا.</div>}
    </div>
  </article>;
}

function CallsPanel({telephony={},slug,showSettings=false,period}){
  const configured=Boolean(telephony.configured);
  const mapped=Boolean(telephony.mapped);
  return <article className={`${styles.panel} ${styles.callsPanel}`}>
    <header className={styles.panelHead}>
      <div><span>Yeastar P550 · {periodLabel(period)}</span><h3>تحليل المكالمات</h3></div>
      {configured&&mapped&&<Link href={rangeHref(
        `/tenant/${slug}/call-reports`,
        period
      )}>التقرير الكامل</Link>}
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

function TeamTable({team=[],slug,period=null}){
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
          <th>{period?'عملاء مسندون خلال الفترة':'عملاء نشطون'}</th>
          <th>أنشطة الفترة</th>
          <th>دفع الفترة</th>
          <th>المكالمات</th>
          <th>نسبة الرد</th>
          <th>مهام متأخرة</th>
        </tr></thead>
        <tbody>
          {team.map(member=><tr key={member.staffId}>
            <td><Link href={rangeHref(
              `/tenant/${slug}/reports/employees/${member.staffId}`,
              period
            )}><b>{member.name}</b><small>{member.jobTitle||ROLE_LABELS[member.roleKey]||'موظف'}</small></Link></td>
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

function SourcesPanel({sources=[],period}){
  const max=Math.max(1,...sources.map(item=>Number(item.total)||0));
  return <article className={styles.panel}>
    <header className={styles.panelHead}>
      <div><span>{period?periodLabel(period):'جودة القنوات'}</span><h3>مصادر العملاء والتحويل</h3></div>
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

function SystemPillars({dashboard,marketing,slug,canReadMarketing}){
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const calls=dashboard.telephony||{};
  const training=dashboard.training||{};
  const marketingSummary=marketing?.summary||{};
  const woo=executive.woocommerceRevenue||{};
  const wooTotals=woo.totals||{};
  const wooMoney=value=>moneyMinorCurrencyExact(
    value,
    woo.currency,
    woo.minorDigits
  );
  const hasWooRevenue=woo.available
    &&wooTotals.netSalesMinor!=null
    &&Number.isFinite(Number(wooTotals.netSalesMinor));
  const orderCount=Number(wooTotals.orderCount)||0;
  const averageOrderMinor=hasWooRevenue&&orderCount>0
    ?Math.round(Number(wooTotals.netSalesMinor)/orderCount)
    :null;
  const hasMarketing=Boolean(marketing)
    &&marketingSummary.spendMinor!=null
    &&Number.isFinite(Number(marketingSummary.spendMinor));
  const marketingDegraded=marketingDataNeedsAttention(marketing);
  const returnValue=commercialReturn(woo,marketing);
  const trainingAvailable=executive.trainingMonthAvailable!==false;
  const closingRate=sales.closingRate==null
    ?null
    :normalizedPercent(sales.closingRate);
  const pillars=[
    ...(woo.connected?[{
      key:'commerce',icon:'◈',title:'مبيعات WooCommerce',tone:'emerald',
      href:rangeHref(`/tenant/${slug}/reports`,dashboard.period),
      headline:hasWooRevenue?wooMoney(wooTotals.netSalesMinor):'—',
      headlineLabel:hasWooRevenue?'صافي المبيعات خلال الفترة':'التقرير غير متاح للفترة',
      stats:[
        ['الطلبات',number(orderCount)],
        ['الإجمالي',hasWooRevenue?wooMoney(wooTotals.grossSalesMinor):'—'],
        ['متوسط الطلب',averageOrderMinor!=null
          ?wooMoney(averageOrderMinor)
          :'—']
      ]
    }]:[]),
    ...(canReadMarketing?[{
      key:'marketing',icon:'◎',title:'الإعلانات',tone:'violet',
      href:rangeHref(`/tenant/${slug}/marketing`,dashboard.period),
      headline:hasMarketing
        ?moneyMinorCurrency(
          marketingSummary.spendMinor,
          marketingSummary.currency
        )
        :'—',
      headlineLabel:hasMarketing
        ?marketingDegraded
          ?'إنفاق مسجل؛ البيانات جزئية أو قديمة'
          :'الإنفاق الفعلي خلال الفترة'
        :'البيانات غير متاحة الآن',
      stats:hasMarketing?[
        ['نتائج المنصات',number(marketingSummary.platformLeads)],
        ['النقرات',number(marketingSummary.clicks)],
        ['مضاعف المبيعات/الإنفاق',returnValue==null?'—':ratio(returnValue)]
      ]:[
        ['حالة البيانات','تعذر التحميل'],
        ['الأرقام البديلة','غير معروضة'],
        ['الإجراء','فتح المركز']
      ]
    }]:[]),
    {
      key:'sales',icon:'↗',title:'التأهيل والمبيعات',tone:'blue',
      href:rangeHref(`/tenant/${slug}/sales`,dashboard.period),
      headline:number(sales.qualifiedEnteredThisMonth),
      headlineLabel:'عميلًا دخل التأهيل للمرة الأولى خلال الفترة',
      stats:[
        ['ما زالت مفتوحة',number(sales.qualifiedOpenFromMonth)],
        ['أُغلقت ناجحًا',number(sales.qualifiedWonFromMonth)],
        ['تقفيل موزعي الفترة',closingRate==null?'—':percent(closingRate)]
      ]
    },
    {
      key:'calls',icon:'☎',title:'المكالمات',tone:'cyan',
      href:rangeHref(`/tenant/${slug}/call-reports`,dashboard.period),
      headline:number(calls.totalCalls),headlineLabel:'مكالمة خلال الفترة',
      stats:[
        ['نسبة الرد',percent(calls.answerRate)],
        ['مكالمات فائتة',number(calls.missedCalls)],
        ['وقت الحديث',duration(calls.talkSeconds)]
      ]
    },
    ...(trainingAvailable?[{
      key:'training',icon:'◫',title:'الطلاب والتدريب',tone:'green',
      href:rangeHref(`/tenant/${slug}/admissions`,dashboard.period),
      headline:number(training.newEnrollmentsThisMonth),headlineLabel:'تسجيلات جديدة خلال الفترة',
      stats:[
        ['جلسات بدأت خلال الفترة',number(training.sessionsThisMonth)],
        ['شهادات صادرة',number(training.issuedCertificatesThisMonth)],
        ['حضور الفترة',Number(training.attendanceRecordsThisMonth)>0
          ?percent(training.attendanceRateThisMonth)
          :'—']
      ]
    }]:[]),
    {
      key:'operations',icon:'◆',title:'التشغيل والفريق',tone:'amber',
      href:rangeHref(`/tenant/${slug}/tasks`,dashboard.period),
      headline:Number(executive.dueTasksThisMonthToDate)<=0
        ?'—'
        :percent(executive.taskCompletionRateThisMonth),
      headlineLabel:'إنجاز المهام المستحقة داخل الفترة',
      stats:[
        ['مكتملة',number(executive.completedDueTasksThisMonthToDate)],
        ['مستحقة',number(executive.dueTasksThisMonthToDate)],
        ['أنشطة المبيعات',number(executive.activitiesThisMonth)]
      ]
    }
  ];

  return <section className={styles.systemSection} aria-label="خريطة أداء المنشأة">
    <header className={styles.sectionHeading}>
      <div><span>{periodLabel(dashboard.period)}</span><h3>خريطة أداء الفترة</h3></div>
      <p>كل محور يعرض النطاق المختار حسب مصدره الفعلي، مع فصل مبيعات المتجر عن دفعات القبول لمنع الازدواج.</p>
    </header>
    <div className={`${styles.pillarGrid} ${
      pillars.length===5
        ?styles.pillarGridFive
        :pillars.length===4
          ?styles.pillarGridFour
          :''
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
          <b><bdi>{pillar.headline}</bdi></b><span>{pillar.headlineLabel}</span>
        </div>
        <dl>
          {pillar.stats.map(([label,value])=><div key={label}>
            <dt>{label}</dt><dd><bdi>{value}</bdi></dd>
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
  const woo=executive.woocommerceRevenue||{};
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
    add('watch','مكالمات تحتاج استردادًا',`${number(calls.missedCalls)} مكالمة فائتة خلال الفترة وفق سجل Yeastar.`);
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
    const returnValue=commercialReturn(woo,marketing);
    if(returnValue===0&&Number(woo.totals?.orderCount)<=0){
      add('watch','إنفاق إعلاني بلا طلبات WooCommerce مكتملة','راجع الحملات ومسار إكمال الطلب قبل زيادة الإنفاق.');
    }else if(returnValue!=null&&returnValue<1){
      add('watch','الإنفاق أعلى من صافي مبيعات المتجر',`مضاعف صافي WooCommerce إلى الإنفاق = ${ratio(returnValue)} خلال الفترة. لا يقيس هذا المؤشر الربحية أو إسناد حملة بعينها.`);
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

function marketingVerdict(marketing,woo){
  const summary=marketing?.summary||{};
  const spend=Number(summary.spendMinor)||0;
  const platformLeads=Number(summary.platformLeads)||0;
  const returnValue=commercialReturn(woo,marketing);
  if(marketingDataNeedsAttention(marketing)){
    return {tone:'watch',label:'بيانات الإعلانات تحتاج مراجعة',text:'توجد مزامنة قديمة أو عملة مستبعدة؛ الرقم المسجل قد يكون جزئيًا، لذلك لم نحكم على مضاعف المبيعات إلى الإنفاق.'};
  }
  if(!spend){
    return {tone:'neutral',label:'بانتظار بيانات كافية',text:'لا يوجد إنفاق مسجل في الفترة الحالية؛ راجع المزامنة أو نطاق التاريخ داخل مركز الحملات.'};
  }
  if(returnValue!=null&&returnValue>=1){
    return {tone:'good',label:'صافي المبيعات أعلى من الإنفاق الإعلاني',text:`مضاعف صافي WooCommerce إلى الإنفاق ${ratio(returnValue)} خلال الفترة. لا يقيس الربحية ولا ينسب المبيعات إلى حملة بعينها.`};
  }
  if(returnValue!=null&&returnValue<1){
    return {tone:'risk',label:'الإنفاق أعلى من صافي مبيعات المتجر',text:`مضاعف صافي WooCommerce إلى الإنفاق ${ratio(returnValue)} خلال الفترة. راجع الكفاءة، مع مراعاة أن المؤشر لا يقيس الربحية.`};
  }
  if(platformLeads>0){
    return {tone:'watch',label:'المنصات تسجل نتائج خلال الفترة',text:'تظهر نتائج إعلانية، لكن لا يمكن حساب العائد التجاري الإجمالي حتى يتوفر تقرير WooCommerce للنطاق نفسه وبالعملة نفسها.'};
  }
  return {tone:'risk',label:'إنفاق دون نتائج مسجلة',text:'يوجد إنفاق بلا نتائج حتى على مستوى المنصة؛ راجع التتبع والاستهداف فورًا.'};
}

function MarketingPulse({marketing,dashboard,slug,canRead}){
  if(!canRead)return null;
  if(!marketing){
    return <article className={`${styles.panel} ${styles.marketingPulse}`}>
      <header className={styles.panelHead}>
        <div><span>الإعلانات والإسناد</span><h3>نبض الحملات</h3></div>
        <Link href={rangeHref(
          `/tenant/${slug}/marketing`,
          dashboard?.period
        )}>فتح مركز الحملات</Link>
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
    (Number(b.platformConversions)||0)-(Number(a.platformConversions)||0)
    ||(Number(b.platformLeads)||0)-(Number(a.platformLeads)||0)
  )[0]||null;
  const woo=dashboard?.executive?.woocommerceRevenue||{};
  const verdict=marketingVerdict(marketing,woo);
  const currency=summary.currency||'SAR';
  const returnValue=commercialReturn(woo,marketing);
  const cards=[
    ['الإنفاق المسجل',moneyMinorCurrency(summary.spendMinor,currency),
      marketingDataNeedsAttention(marketing)
        ?'قد يكون جزئيًا؛ راجع صحة الربط والعملات'
        :'الإنفاق الفعلي من بيانات المنصات خلال الفترة'],
    ['نتائج المنصات',number(summary.platformLeads),'قبل التحقق داخل CRM'],
    ['النقرات',number(summary.clicks),'النقرات المسجلة في المنصات'],
    ['مرات الظهور',number(summary.impressions),'الظهور المسجل في المنصات'],
    ['تكلفة نتيجة المنصة',summary.platformCplMinor==null
      ?'—'
      :moneyMinorCurrency(summary.platformCplMinor,currency),'الإنفاق ÷ نتائج المنصات'],
    ['مضاعف المبيعات إلى الإنفاق',returnValue==null? '—':ratio(returnValue),'صافي WooCommerce ÷ الإنفاق؛ لا يقيس الربحية']
  ];

  return <article className={`${styles.panel} ${styles.marketingPulse}`}>
    <header className={styles.panelHead}>
      <div><span>{periodLabel({
        ...marketing.range,
        timeZone:marketing.range?.timeZone||marketing.settings?.timezone
      })}</span><h3>نبض الإعلانات خلال الفترة</h3></div>
      <Link href={rangeHref(
        `/tenant/${slug}/marketing`,
        dashboard?.period
      )}>التحليل الكامل</Link>
    </header>
    <div className={styles.marketingBody}>
      <div className={styles.marketingMetrics}>
        {cards.map(([label,value,note])=><div key={label}>
          <span>{label}</span><b><bdi>{value}</bdi></b><small>{note}</small>
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
  const responseRate=Number(
    leads.firstResponseSlaRate??sales.firstResponseSlaRate
  )||0;
  const responseMinutes=Number(
    leads.averageFirstResponseMinutes??sales.averageFirstResponseMinutes
  )||0;
  const dueTasks=Number(executive.dueTasksThisMonthToDate)||0;
  const totalCalls=Number(calls.totalCalls)||0;
  const distributed=Number(sales.distributedThisMonth)||0;
  const items=[
    {
      label:'إنجاز المهام المستحقة',
      value:dueTasks>0
        ?normalizedPercent(executive.taskCompletionRateThisMonth)
        :null,
      note:`${number(executive.completedDueTasksThisMonthToDate)} من ${number(executive.dueTasksThisMonthToDate)} مهمة داخل الفترة`
    },
    {
      label:'الرد على المكالمات',
      value:totalCalls>0?normalizedPercent(calls.answerRate):null,
      note:`${number(calls.answeredCalls)} من ${number(calls.totalCalls)} مكالمة`
    },
    {
      label:'الالتزام بأول متابعة',
      value:distributed>0?normalizedPercent(responseRate):null,
      note:responseMinutes
        ?`${number(responseMinutes)} دقيقة متوسط أول رد`
        :'لا توجد مدة استجابة مسجلة'
    },
    {
      label:'تحويل العملاء للدفع',
      value:distributed>0&&sales.closingRate!=null
        ?normalizedPercent(sales.closingRate)
        :null,
      note:`${number(sales.paidFromDistributedThisMonth)} دفعوا من ${number(sales.distributedThisMonth)} موزعين خلال الفترة`
    }
  ];

  return <section className={styles.health} aria-label="صحة المنشأة">
    <header className={styles.healthHead}>
      <div>
        <span>{periodLabel(dashboard.period)}</span>
        <h3>صحة أداء الفترة</h3>
      </div>
      <p>أربع نسب تشغيلية محسوبة على النطاق المختار فقط، من مصادرها المسجلة.</p>
    </header>
    <div className={styles.healthGrid}>
      {items.map(item=>{
        const available=item.value!=null
          &&Number.isFinite(Number(item.value));
        const normalized=available?Math.round(item.value):0;
        return <article key={item.label}>
        <div>
          <span>{item.label}</span>
          <b>{available?percent(normalized):'—'}</b>
        </div>
        <i
          role="progressbar"
          aria-label={item.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={available?normalized:undefined}
          aria-valuetext={available?undefined:'لا توجد بيانات كافية'}
        >
          <span style={{width:`${available?item.value:0}%`}}/>
        </i>
        <small>{item.note}</small>
      </article>})}
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
  fallbackRoleKey='tenant_user',
  range=null
}){
  const role=dashboard?.viewer?.roleKey||fallbackRoleKey||'tenant_user';
  const copy=ROLE_COPY[role]||ROLE_COPY.tenant_user;
  const viewer=dashboard?.viewer||{};
  const actions=quickActions(slug,permissions,range);
  const canFilterDate=EXECUTIVE_ROLES.has(role)
    &&dashboard?.permissions?.crm!==false;

  if(dashboard?.unavailable){
    return <div className={styles.dashboard}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </section>
      {canFilterDate&&<DashboardDateFilter
        slug={slug}
        range={range}
        period={range}
      />}
      <div className={styles.fallbackNote} role="alert">
        تعذر تحميل مؤشرات الأداء الموثوقة الآن. لم نعرض أرقامًا بديلة حتى لا تظهر بيانات غير دقيقة؛ أعد المحاولة بعد قليل.
      </div>
      <TaskList tasks={operations?.tasks||[]} slug={slug} period={range}/>
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
        <span>نطاق مؤشرات اللوحة</span>
        <b>{periodLabel(dashboard?.period)}</b>
        <small>آخر تحديث {when(
          dashboard?.generatedAt,
          dashboard?.period?.timeZone||dashboard?.period?.timezone
        )}</small>
      </div>
    </section>

    {canFilterDate&&<DashboardDateFilter
      slug={slug}
      range={range}
      period={dashboard?.period}
    />}

    <ReadinessAlerts role={role} dashboard={dashboard||{}}/>
    {EXECUTIVE_ROLES.has(role)
      ?<ExecutiveMetricSection items={metrics} period={dashboard?.period}/>
      :<MetricCards items={metrics}/>
    }
    {EXECUTIVE_ROLES.has(role)&&<SystemPillars
      dashboard={dashboard||{}}
      marketing={marketing}
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
      <Trend daily={dashboard?.daily||[]} period={dashboard?.period}/>
      <TaskList
        tasks={operations?.tasks||[]}
        slug={slug}
        period={dashboard?.period}
      />
    </section>

    {showMarketing&&<MarketingPulse
      marketing={marketing}
      dashboard={dashboard||{}}
      slug={slug}
      canRead={canReadMarketing}
    />}

    {showCalls&&<CallsPanel
      telephony={dashboard?.telephony||{}}
      slug={slug}
      showSettings={permissions.includes('tenant.settings.manage')}
      period={dashboard?.period}
    />}

    {showSources&&<section className={styles.grid}>
      <SourcesPanel
        sources={dashboard?.sources||[]}
        period={EXECUTIVE_ROLES.has(role)?dashboard?.period:null}
      />
      <article className={styles.panel}>
        <header className={styles.panelHead}>
          <div><span>{periodLabel(dashboard?.period)}</span><h3>الاستجابة والتوزيع</h3></div>
        </header>
        <div className={styles.callStats}>
          <div><span>متوسط أول رد</span><b>{number((dashboard?.leadOperations||{}).averageFirstResponseMinutes||(dashboard?.sales||{}).averageFirstResponseMinutes)} د</b></div>
          <div><span>الالتزام بالمهلة</span><b>{percent((dashboard?.leadOperations||{}).firstResponseSlaRate||(dashboard?.sales||{}).firstResponseSlaRate)}</b></div>
          <div><span>وُزعوا خلال الفترة</span><b>{number((dashboard?.sales||{}).distributedThisMonth)}</b></div>
          <div><span>دفعوا من موزعي الفترة</span><b>{number((dashboard?.sales||{}).paidFromDistributedThisMonth)}</b></div>
        </div>
      </article>
    </section>}

    {showTeam&&<TeamTable
      team={dashboard?.team||[]}
      slug={slug}
      period={EXECUTIVE_ROLES.has(role)?dashboard?.period:null}
    />}

    {role==='sales_user'&&<section className={styles.personalStrip}>
      <div><span>حافز مستحق أو قيد المراجعة</span><b>{money((dashboard?.personal||{}).pendingIncentive)}</b></div>
      <div><span>حافز مدفوع هذا الشهر</span><b>{money((dashboard?.personal||{}).paidIncentiveThisMonth)}</b></div>
      <div><span>المهام المكتملة في موعدها</span><b>{number((dashboard?.personal||{}).onTimeThisMonth)}</b></div>
      <Link href={`/tenant/${slug}/incentives`}>تفاصيل الحوافز</Link>
    </section>}

  </div>;
}
