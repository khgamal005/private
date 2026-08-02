import styles from './achievement-board.module.css';

const SALES_ROLES=new Set(['sales_user','sales_supervisor','sales_manager']);

function number(value){
  return new Intl.NumberFormat('ar-EG').format(Number(value)||0);
}

function money(value){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',
    currency:'SAR',
    maximumFractionDigits:0
  }).format(Number(value)||0);
}

function moneyMinor(value){
  return money((Number(value)||0)/100);
}

function metric(icon,label,value,note,tone){
  return {icon,label,value,note,tone};
}

const COUNT_TARGETS=new Set([
  'registrations',
  'customers',
  'sales_count',
  'paid_customers',
  'activities',
  'followups'
]);

function targetValue(value,metricType){
  return COUNT_TARGETS.has(metricType)?number(value):money(value);
}

export default function AchievementBoard({achievement}){
  if(!achievement?.viewer)return null;
  const viewer=achievement.viewer||{};
  const personal=achievement.personal||{};
  const sales=achievement.sales||{};
  const ranking=achievement.ranking||{};
  const target=achievement.target||{};
  const role=viewer.roleKey||'tenant_user';
  const isSales=SALES_ROLES.has(role);

  const items=isSales?[
    metric('▥','العملاء',number(sales.customers),`${number(sales.activeCustomers)} قيد المتابعة`,'blue'),
    metric('◎','الفرص المفتوحة',number(sales.openOpportunities),`قيمة مرجحة ${moneyMinor(sales.openOpportunityValueMinor)}`,'purple'),
    metric('◉','حوافزك المستحقة',money(sales.dueIncentive),'معلقة للمراجعة أو الاعتماد','green'),
    metric('↗','حوافزك المتوقعة',money(sales.expectedIncentive),'تقدير من النتائج الحالية','amber'),
    metric('♜','مبيعات هذا الشهر',money(sales.salesThisMonth),`${number(sales.paidCustomers)} تسجيلًا مدفوعًا`,'pink')
  ]:[
    metric('✓','مكتمل هذا الشهر',number(personal.completedThisMonth),'إنجازات مسجلة بالنظام','green'),
    metric('◷','مهام اليوم',number(personal.tasksToday),'المطلوب إنجازه اليوم','blue'),
    metric('▤','مهام مفتوحة',number(personal.openTasks),'إجمالي المهام الحالية','purple'),
    metric('!','مهام متأخرة',number(personal.overdueTasks),'تحتاج معالجة أو إعادة جدولة','pink'),
    metric('↗','أنشطة اليوم',number(personal.activitiesToday),'نشاطات مرتبطة بعملك','amber')
  ];

  const progress=Math.min(100,Math.max(0,Number(target.progressPercent)||0));

  return <section className={styles.wrap} aria-label="لوحة الإنجاز الشخصية">
    <header className={styles.greeting}>
      <div>
        <span className={styles.eyebrow}>أداؤك الشخصي</span>
        <h1>مرحبًا، {viewer.name||'زميلنا'} <span aria-hidden="true">👋</span></h1>
        <p>ملخص سريع لأهم مؤشرات الأداء والعملاء والفرص والحوافز والالتزام بالتنفيذ.</p>
      </div>
      {role==='sales_user'&&<div className={styles.rankCard}>
        <span>ترتيبك في المبيعات</span>
        {ranking.available?<>
          <b>#{number(ranking.rank)}</b>
          <small>من {number(ranking.teamSize)} داخل فريق {ranking.teamName}</small>
        </>:<>
          <b>—</b>
          <small>لم يتم إسنادك إلى فريق مبيعات بعد</small>
        </>}
      </div>}
      {role==='sales_supervisor'&&<div className={styles.rankCard}>
        <span>فريقك المباشر</span>
        <b>{number(ranking.teamSize)}</b>
        <small>مسؤولو مبيعات مسندون إليك</small>
      </div>}
    </header>

    <div className={styles.board}>
      <header className={styles.boardHead}>
        <div><span aria-hidden="true">✧</span><h2>لوحة إنجازك</h2></div>
        <small>{isSales?'تتحدث من بيانات المبيعات والحوافز الفعلية':'تتحدث من المهام والأنشطة الفعلية'}</small>
      </header>

      <div className={styles.metrics}>
        {items.map(item=><article className={`${styles.metric} ${styles[item.tone]}`} key={item.label}>
          <i aria-hidden="true">{item.icon}</i>
          <b>{item.value}</b>
          <span>{item.label}</span>
          <small>{item.note}</small>
        </article>)}
      </div>

      {isSales&&<div className={styles.progressBox}>
        <div className={styles.progressTop}>
          <div><span>التقدم نحو الهدف الشهري</span><b>{number(Math.round(progress))}٪</b></div>
          <small>{target.targetValue>0
            ?`${targetValue(target.achievedValue,target.metricType)} من ${targetValue(target.targetValue,target.metricType)}`
            :'لم يُحدد هدف شهري لهذا الموظف بعد'}</small>
        </div>
        <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <i style={{width:`${progress}%`}}/>
        </div>
      </div>}
    </div>
  </section>;
}
