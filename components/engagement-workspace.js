'use client';

import {useEffect,useMemo,useState} from 'react';
import styles from './incentive-workspace.module.css';

const metricLabels={
  revenue:'الإيرادات',
  registered_customers:'العملاء المسجلون',
  contracts:'العقود',
  closed_opportunities:'الفرص المغلقة',
  paid_registrations:'التسجيلات المدفوعة',
  courses_sold:'الدورات المباعة',
  collections:'التحصيل',
  conversion_rate:'معدل التحويل',
  course:'دورة أو منتج',
  branch:'فرع',
  campaign:'حملة'
};
const stateLabels={
  expected:'متوقع',pending:'معلّق',due:'مستحق',approved:'معتمد',
  paid:'مدفوع',cancelled:'ملغى',refunded:'مسترد'
};
const triggerLabels={
  customer_registered:'بعد تسجيل العميل',
  registration_confirmed:'بعد تأكيد التسجيل',
  payment_verified:'بعد التحقق من الدفع',
  cancellation_window_passed:'بعد انتهاء مهلة الإلغاء'
};
const scopeLabels={
  employee:'موظفون محددون',team:'فريق مبيعات',department:'قسم',
  branch:'فرع',course:'دورة أو منتج',campaign:'حملة'
};
const planSteps=[
  {title:'الأساسيات',description:'الفترة ونوع الهدف'},
  {title:'طريقة الحساب',description:'القيمة والاستحقاق'},
  {title:'الفريق والتفعيل',description:'الأهداف وحالة البداية'}
];
const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',currency:'SAR',maximumFractionDigits:2
}).format(Number(value||0));
const number=value=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(Number(value||0));
const today=()=>new Date().toISOString().slice(0,10);
const monthEnd=()=>{
  const date=new Date();
  return new Date(date.getFullYear(),date.getMonth()+1,0).toISOString().slice(0,10);
};
const initialPlan=()=>({
  title:'',periodStart:today(),periodEnd:monthEnd(),metricType:'revenue',
  calculationType:'percentage',incentiveValue:'',tiers:[],
  earningTrigger:'payment_verified',cancellationWindowDays:0,
  scopeType:'employee',scopeReference:'',status:'active',assignments:[]
});

function metricValue(value,type){
  return ['revenue','collections'].includes(type)?money(value):number(value);
}

function Progress({value}){
  const safe=Math.max(0,Number(value||0));
  return <div className={styles.progress} aria-label={`${Math.round(safe)}%`}>
    <i style={{width:`${Math.min(100,safe)}%`}}/>
  </div>;
}

export default function EngagementWorkspace({slug}){
  const [tab,setTab]=useState('overview');
  const [data,setData]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [showPlan,setShowPlan]=useState(false);
  const [planStep,setPlanStep]=useState(1);
  const [planError,setPlanError]=useState('');
  const [plan,setPlan]=useState(initialPlan);
  const [showAnnouncement,setShowAnnouncement]=useState(false);
  const [announcement,setAnnouncement]=useState({
    type:'notice',priority:'normal',title:'',body:'',startsAt:'',endsAt:'',
    requiresAck:false,isPinned:false
  });

  async function api(action,{method='GET',body}={}){
    const suffix=method==='GET'?`?tenantSlug=${encodeURIComponent(slug)}`:'';
    const response=await fetch(`/api/engagement/${action}${suffix}`,{
      method,credentials:'include',
      headers:method==='GET'?undefined:{'content-type':'application/json'},
      body:body?JSON.stringify({...body,tenantSlug:slug}):undefined,
      cache:'no-store'
    });
    const payload=await response.json().catch(()=>({error:'تعذر قراءة استجابة النظام'}));
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload;
  }

  async function load(){
    try{
      setError('');
      setData(await api('snapshot'));
    }catch(err){setError(err.message)}
  }
  useEffect(()=>{load()},[slug]);
  useEffect(()=>{
    if(!showPlan&&!showAnnouncement)return undefined;
    const previousOverflow=document.body.style.overflow;
    const closeOnEscape=event=>{
      if(event.key!=='Escape'||busy)return;
      setShowPlan(false);
      setShowAnnouncement(false);
      setPlanError('');
    };
    document.body.style.overflow='hidden';
    window.addEventListener('keydown',closeOnEscape);
    return ()=>{
      document.body.style.overflow=previousOverflow;
      window.removeEventListener('keydown',closeOnEscape);
    };
  },[showPlan,showAnnouncement,busy]);

  const assignments=data?.assignments||[];
  const events=data?.events||[];
  const plans=data?.plans||[];
  const viewer=data?.viewer||{};
  const totals=useMemo(()=>assignments.reduce((result,item)=>({
    target:result.target+Number(item.target||0),
    achieved:result.achieved+Number(item.achieved||0),
    expected:result.expected+Number(item.expected||0),
    pending:result.pending+Number(item.pending||0),
    due:result.due+Number(item.due||0),
    approved:result.approved+Number(item.approved||0),
    paid:result.paid+Number(item.paid||0)
  }),{target:0,achieved:0,expected:0,pending:0,due:0,approved:0,paid:0}),[assignments]);

  function chooseEmployee(employee,checked){
    setPlan(current=>({
      ...current,
      assignments:checked
        ?[...current.assignments,{staffId:employee.id,supervisorStaffId:'',targetValue:''}]
        :current.assignments.filter(item=>item.staffId!==employee.id)
    }));
  }

  function updateAssignment(staffId,key,value){
    setPlan(current=>({
      ...current,
      assignments:current.assignments.map(item=>item.staffId===staffId?{...item,[key]:value}:item)
    }));
  }

  function addTier(){
    setPlan(current=>({
      ...current,
      tiers:[...current.tiers,{from:'',to:'',type:'percentage',value:''}]
    }));
  }

  function updateTier(index,key,value){
    setPlan(current=>({
      ...current,
      tiers:current.tiers.map((tier,tierIndex)=>tierIndex===index?{...tier,[key]:value}:tier)
    }));
  }

  function openPlan(){
    setError('');
    setPlanError('');
    setPlanStep(1);
    setShowPlan(true);
  }

  function closePlan(){
    if(busy)return;
    setShowPlan(false);
    setPlanError('');
  }

  async function savePlan(event){
    event.preventDefault();
    setPlanError('');
    if(planStep===1&&plan.periodEnd<plan.periodStart){
      setPlanError('تاريخ نهاية الخطة يجب أن يكون بعد تاريخ البداية.');
      return;
    }
    if(planStep===2&&plan.calculationType==='tiered'&&!plan.tiers.length){
      setPlanError('أضف شريحة حافز واحدة على الأقل قبل الانتقال للفريق.');
      return;
    }
    if(planStep<3){
      setPlanStep(step=>step+1);
      return;
    }
    if(!plan.assignments.length){
      setPlanError('اختر موظفًا واحدًا على الأقل وحدد هدفه.');
      return;
    }
    setBusy(true);setNotice('');
    try{
      await api('create-plan',{method:'POST',body:{payload:{
        ...plan,
        incentiveValue:Number(plan.incentiveValue||0),
        cancellationWindowDays:Number(plan.cancellationWindowDays||0),
        tiers:plan.tiers.map(tier=>({
          from:Number(tier.from||0),to:tier.to===''?null:Number(tier.to),
          type:tier.type,value:Number(tier.value||0)
        })),
        assignments:plan.assignments.map(item=>({
          ...item,targetValue:Number(item.targetValue||0),
          supervisorStaffId:item.supervisorStaffId||null
        }))
      }}});
      setNotice('تم حفظ خطة الحوافز وربطها بالنتائج الفعلية.');
      setShowPlan(false);setPlan(initialPlan());setPlanStep(1);await load();
    }catch(err){setPlanError(err.message)}finally{setBusy(false)}
  }

  async function runAction(action,payload,success){
    setBusy(true);setError('');setNotice('');
    try{
      await api(action,{method:'POST',body:{payload}});
      setNotice(success);await load();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function saveAnnouncement(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      await api('announcement',{method:'POST',body:announcement});
      setNotice('تم نشر الرسالة داخل المنشأة.');
      setAnnouncement({...announcement,title:'',body:''});
      setShowAnnouncement(false);await load();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function acknowledge(id){
    setBusy(true);
    try{await api('read',{method:'POST',body:{announcementId:id,acknowledge:true}});await load()}
    catch(err){setError(err.message)}finally{setBusy(false)}
  }

  if(!data&&!error)return <div className={styles.loading}>جارٍ تجهيز لوحة الأهداف والحوافز…</div>;

  return <>
    <header className="mt-page-head">
      <div>
        <small>GOALS & INCENTIVES</small>
        <h2>الأهداف والحوافز</h2>
        <p>من الهدف إلى التحصيل، ثم الاستحقاق والاعتماد والصرف في سجل واحد واضح.</p>
      </div>
      <div className="mt-page-actions">
        {viewer.canManagePlans&&<button className="mt-button soft" disabled={busy}
          onClick={()=>runAction('sync',{},'تمت مزامنة الحوافز مع أحدث التسجيلات والمدفوعات.')}>
          ↻ مزامنة النتائج
        </button>}
        {viewer.canManagePlans&&<button className="mt-button primary" onClick={openPlan}>
          + خطة حوافز
        </button>}
        {tab==='communications'&&viewer.canManagePlans&&
          <button className="mt-button primary" onClick={()=>setShowAnnouncement(true)}>+ رسالة داخلية</button>}
      </div>
    </header>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <nav className={styles.tabs} aria-label="أقسام الحوافز">
      {[
        ['overview','نظرة عامة'],['plans','خطط الحوافز'],['ledger','سجل الاستحقاقات'],
        ['reports','تقارير الأداء'],['communications','التنويهات والقرارات']
      ].map(([key,label])=><button key={key} className={tab===key?styles.active:''}
        onClick={()=>setTab(key)}>{label}</button>)}
    </nav>

    {tab==='overview'&&<>
      <section className={styles.hero}>
        <div>
          <span>دورة الحافز المعتمدة</span>
          <b>متوقع ← معلّق ← مستحق ← معتمد ← مدفوع</b>
          <small>لا يصبح الحافز مستحقًا إلا بعد تحقق شرط الخطة من بيانات التسجيل أو الدفع.</small>
        </div>
        <div className={styles.scope}>
          <span>نطاق العرض</span>
          <b>{viewer.scope==='all'?'كل فريق المبيعات':viewer.scope==='team'?'فريقك المباشر':'أهدافك وحوافزك'}</b>
        </div>
      </section>
      <section className={styles.kpis}>
        <article><span>الهدف الحالي</span><b>{number(totals.target)}</b><small>حسب مقاييس الخطط النشطة</small></article>
        <article><span>الحافز المتوقع</span><b>{money(totals.expected)}</b><small>نتائج لم تستوف شرط الاستحقاق</small></article>
        <article><span>الحافز المعلّق</span><b>{money(totals.pending)}</b><small>بانتظار تحقق أو انتهاء مهلة</small></article>
        <article className={styles.success}><span>الحافز المستحق</span><b>{money(totals.due)}</b><small>جاهز للمراجعة والاعتماد</small></article>
        <article><span>الحافز المعتمد</span><b>{money(totals.approved)}</b><small>معتمد وبانتظار الصرف</small></article>
        <article><span>الحافز المدفوع</span><b>{money(totals.paid)}</b><small>تم توثيق صرفه</small></article>
      </section>
      <section className="mt-panel">
        <header className="mt-panel-head"><div><h3>بطاقات تحقيق الأهداف</h3><p>الإنجاز الحقيقي والحافز لكل موظف</p></div></header>
        <div className={styles.peopleGrid}>
          {assignments.map(item=>{
            const progress=Math.round(Number(item.achieved||0)/Math.max(1,Number(item.target||0))*100);
            return <article key={item.id}>
              <header>
                <div><b>{item.employeeName}</b><small>{item.jobTitle||metricLabels[item.metricType]}</small></div>
                <strong>{progress}%</strong>
              </header>
              <Progress value={progress}/>
              <p>{metricValue(item.achieved,item.metricType)} من {metricValue(item.target,item.metricType)}</p>
              <footer>
                <span>متوقع <b>{money(item.expected)}</b></span>
                <span>مستحق <b>{money(item.due)}</b></span>
                <span>مدفوع <b>{money(item.paid)}</b></span>
              </footer>
            </article>;
          })}
          {!assignments.length&&<Empty title="لا توجد خطة نشطة"
            text={viewer.canManagePlans?'ابدأ بخطة بسيطة وحدد الهدف وطريقة الحساب والموظفين.':'لم تُسند إليك خطة أهداف خلال الفترة الحالية.'}/>}
        </div>
      </section>
    </>}

    {tab==='plans'&&<section className={styles.planGrid}>
      {plans.map(item=><article key={item.id}>
        <header>
          <span className={`${styles.status} ${styles[item.status]}`}>{item.status==='active'?'نشطة':item.status==='draft'?'مسودة':item.status==='closed'?'مغلقة':'مؤرشفة'}</span>
          <small>{item.assignmentCount} موظف</small>
        </header>
        <h3>{item.title}</h3>
        <p>{metricLabels[item.metricType]} · {item.calculationType==='percentage'?'نسبة':item.calculationType==='fixed'?'مبلغ ثابت':'شرائح متدرجة'}</p>
        <dl>
          <div><dt>الفترة</dt><dd>{item.periodStart} — {item.periodEnd}</dd></div>
          <div><dt>شرط الاستحقاق</dt><dd>{triggerLabels[item.earningTrigger]}</dd></div>
          <div><dt>النطاق</dt><dd>{scopeLabels[item.scopeType]}</dd></div>
          <div><dt>مهلة الإلغاء</dt><dd>{item.cancellationWindowDays?`${item.cancellationWindowDays} يوم`:'بدون مهلة'}</dd></div>
        </dl>
        {item.calculationType==='tiered'&&<div className={styles.tierSummary}>
          {(item.tiers||[]).map((tier,index)=><span key={index}>من {number(tier.from)}: {tier.type==='percentage'?`${tier.value}%`:money(tier.value)}</span>)}
        </div>}
        {viewer.canManagePlans&&<footer>
          {item.status==='active'
            ?<button disabled={busy} onClick={()=>runAction('plan-status',{planId:item.id,status:'closed'},'تم إغلاق الخطة مع الاحتفاظ بسجلها.')}>إغلاق الخطة</button>
            :item.status==='draft'&&<button disabled={busy} onClick={()=>runAction('plan-status',{planId:item.id,status:'active'},'تم تفعيل الخطة ومزامنة النتائج.')}>تفعيل الخطة</button>}
        </footer>}
      </article>)}
      {!plans.length&&<Empty title="لا توجد خطط حوافز" text="أنشئ أول خطة وحدد الشرائح وشرط الاستحقاق بدقة."/>}
    </section>}

    {tab==='ledger'&&<section className="mt-panel">
      <header className="mt-panel-head"><div><h3>سجل الاستحقاقات</h3><p>كل حافز مرتبط بمصدره وحالته الحالية</p></div></header>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>الموظف</th><th>العميل / الدورة</th><th>الخطة</th><th>القيمة المحصلة</th><th>الحافز</th><th>الحالة</th><th>الإجراء</th></tr></thead>
        <tbody>{events.map(item=><tr key={item.id}>
          <td><b>{item.employeeName}</b><small>{new Date(item.occurredAt).toLocaleDateString('ar-SA')}</small></td>
          <td><b>{item.customerName||'—'}</b><small>{item.courseName||item.campaignName||'بدون تصنيف'}</small></td>
          <td>{item.planTitle}</td><td>{money(item.revenueAmount)}</td><td><b>{money(item.incentiveAmount)}</b></td>
          <td><span className={`${styles.state} ${styles[item.state]}`}>{stateLabels[item.state]}</span></td>
          <td><div className={styles.rowActions}>
            {item.state==='due'&&viewer.canApprove&&<button disabled={busy}
              onClick={()=>runAction('transition-event',{eventId:item.id,state:'approved'},'تم اعتماد الحافز.')}>اعتماد</button>}
            {item.state==='approved'&&viewer.canPay&&<button disabled={busy}
              onClick={()=>runAction('transition-event',{eventId:item.id,state:'paid'},'تم توثيق صرف الحافز.')}>تأكيد الصرف</button>}
            {!['paid','cancelled','refunded'].includes(item.state)&&viewer.canApprove&&<button className={styles.danger} disabled={busy}
              onClick={()=>runAction('transition-event',{eventId:item.id,state:'cancelled',reason:'إلغاء إداري'},'تم إلغاء الحافز مع حفظ السبب.')}>إلغاء</button>}
            {!((item.state==='due'&&viewer.canApprove)||(item.state==='approved'&&viewer.canPay)||viewer.canApprove)&&<small>لا إجراء مطلوب</small>}
          </div></td>
        </tr>)}</tbody>
      </table>{!events.length&&<Empty title="لا يوجد سجل بعد" text="سيظهر الحافز تلقائيًا عند تسجيل نتائج مرتبطة بخطة نشطة."/>}</div>
    </section>}

    {tab==='reports'&&<section className={styles.reportGrid}>
      <article><h3>نسبة تحقيق الهدف</h3><b>{totals.target?Math.round(totals.achieved/totals.target*100):0}%</b><Progress value={totals.target?totals.achieved/totals.target*100:0}/><p>إجمالي الإنجاز مقارنة بالأهداف المسندة في النطاق الذي تراه.</p></article>
      <article><h3>جاهز للاعتماد</h3><b>{money(totals.due)}</b><p>{events.filter(item=>item.state==='due').length} سجل مستحق يحتاج قرارًا.</p></article>
      <article><h3>نسبة الصرف</h3><b>{totals.approved+totals.paid?Math.round(totals.paid/(totals.approved+totals.paid)*100):0}%</b><p>الحوافز المدفوعة من إجمالي المعتمد والمدفوع.</p></article>
      <article><h3>حماية الاستحقاق</h3><b>{events.filter(item=>['cancelled','refunded'].includes(item.state)).length}</b><p>حوافز ألغيت أو استردت دون التأثير على السجل التاريخي.</p></article>
    </section>}

    {tab==='communications'&&<section className={styles.announcementGrid}>
      {(data?.announcements||[]).map(item=><article className={`${styles.announcement} ${styles[item.priority]}`} key={item.id}>
        <header><span>{item.type==='decision'?'قرار إداري':item.type==='offer'?'عرض':item.type==='urgent'?'تنبيه عاجل':'تنويه'}</span><time>{new Date(item.createdAt).toLocaleDateString('ar-SA')}</time></header>
        <h3>{item.title}</h3><p>{item.body}</p>
        <footer><span>{item.endsAt?`يظهر حتى ${new Date(item.endsAt).toLocaleDateString('ar-SA')}`:'بدون تاريخ انتهاء'}</span>
          {item.requiresAck&&!item.acknowledgedAt&&<button onClick={()=>acknowledge(item.id)} disabled={busy}>إقرار الاطلاع</button>}
          {item.acknowledgedAt&&<b>✓ تم الاطلاع</b>}
        </footer>
      </article>)}
      {!(data?.announcements||[]).length&&<Empty title="لا توجد رسائل داخلية" text="ستظهر التنويهات والقرارات المنشورة هنا."/>}
    </section>}

    {showPlan&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closePlan}/>
      <form className={`mt-modal ${styles.planModal}`} onSubmit={savePlan}
        role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">
        <header>
          <div><small>إعداد خطة جديدة</small><h3 id="plan-modal-title">إنشاء خطة أهداف وحوافز</h3></div>
          <button type="button" onClick={closePlan} aria-label="إغلاق">×</button>
        </header>
        <ol className={styles.steps} aria-label="خطوات إنشاء الخطة">
          {planSteps.map((step,index)=>{
            const number=index+1;
            const state=number<planStep?styles.done:number===planStep?styles.active:'';
            return <li key={step.title} className={state} aria-current={number===planStep?'step':undefined}>
              <i>{number<planStep?'✓':number}</i>
              <span><b>{step.title}</b><small>{step.description}</small></span>
            </li>;
          })}
        </ol>
        <div className={`mt-form ${styles.planForm}`}>
          {planStep===1&&<>
            <label className="mt-field wide">اسم الخطة<input required value={plan.title} onChange={event=>setPlan({...plan,title:event.target.value})} placeholder="مثال: حوافز مبيعات شهر أغسطس"/></label>
            <label className="mt-field">بداية الفترة<input type="date" required value={plan.periodStart} onChange={event=>setPlan({...plan,periodStart:event.target.value})}/></label>
            <label className="mt-field">نهاية الفترة<input type="date" required value={plan.periodEnd} onChange={event=>setPlan({...plan,periodEnd:event.target.value})}/></label>
            <label className="mt-field wide">نوع الهدف<select value={plan.metricType} onChange={event=>setPlan({...plan,metricType:event.target.value})}>
              {Object.entries(metricLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select></label>
            <div className={`${styles.explainer} mt-field wide`}><b>كيف يعمل؟</b><span>الهدف يقيس الإنجاز، والحافز يُحسب بصورة مستقلة حسب النسبة أو المبلغ أو الشرائح.</span></div>
          </>}
          {planStep===2&&<>
            <label className="mt-field">طريقة الحساب<select value={plan.calculationType} onChange={event=>setPlan({...plan,calculationType:event.target.value})}>
              <option value="percentage">نسبة من المبلغ المحصل</option><option value="fixed">مبلغ ثابت لكل إنجاز</option><option value="tiered">شرائح حوافز</option>
            </select></label>
            {plan.calculationType!=='tiered'&&<label className="mt-field">قيمة الحافز<input type="number" min="0" step=".01" required value={plan.incentiveValue} onChange={event=>setPlan({...plan,incentiveValue:event.target.value})} placeholder={plan.calculationType==='percentage'?'مثال: 2.5':'مثال: 100'}/></label>}
            {plan.calculationType==='tiered'&&<div className={`${styles.tiers} mt-field wide`}>
              <header><div><b>شرائح الحوافز</b><small>تُطبّق الشريحة التي وصل إليها الإنجاز وقت تسجيل النتيجة.</small></div><button type="button" onClick={addTier}>+ شريحة</button></header>
              {plan.tiers.map((tier,index)=><div key={index}>
                <input type="number" min="0" required placeholder="من" value={tier.from} onChange={event=>updateTier(index,'from',event.target.value)}/>
                <input type="number" min="0" placeholder="إلى (اختياري)" value={tier.to} onChange={event=>updateTier(index,'to',event.target.value)}/>
                <select value={tier.type} onChange={event=>updateTier(index,'type',event.target.value)}><option value="percentage">نسبة</option><option value="fixed">مبلغ ثابت</option></select>
                <input type="number" min="0" step=".01" required placeholder="القيمة" value={tier.value} onChange={event=>updateTier(index,'value',event.target.value)}/>
                <button type="button" onClick={()=>setPlan({...plan,tiers:plan.tiers.filter((_,tierIndex)=>tierIndex!==index)})}>×</button>
              </div>)}
              {!plan.tiers.length&&<p>أضف أول شريحة لتحديد الحافز عند كل مستوى إنجاز.</p>}
            </div>}
            <label className="mt-field">شرط الاستحقاق<select value={plan.earningTrigger} onChange={event=>setPlan({...plan,earningTrigger:event.target.value})}>
              {Object.entries(triggerLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select></label>
            <label className="mt-field">مهلة الإلغاء بالأيام<input type="number" min="0" max="90" value={plan.cancellationWindowDays} onChange={event=>setPlan({...plan,cancellationWindowDays:event.target.value})}/></label>
          </>}
          {planStep===3&&<>
            <label className="mt-field">نطاق الخطة<select value={plan.scopeType} onChange={event=>setPlan({...plan,scopeType:event.target.value})}>
              {Object.entries(scopeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select></label>
            {['branch','course','campaign','department'].includes(plan.scopeType)&&<label className="mt-field">اسم أو معرّف النطاق<input required value={plan.scopeReference} onChange={event=>setPlan({...plan,scopeReference:event.target.value})}/></label>}
            <div className={`${styles.assignmentSummary} mt-field wide`}>
              <div><b>اختيار الفريق وتوزيع الأهداف</b><small>فعّل الموظف ثم أدخل هدفه وحدد مشرفه المباشر عند الحاجة.</small></div>
              <span>{plan.assignments.length} محدد</span>
            </div>
            <fieldset className={`${styles.employeePicker} mt-field wide`}><legend>الموظفون والأهداف</legend>
              {(data?.employees||[]).map(employee=>{
                const selected=plan.assignments.find(item=>item.staffId===employee.id);
                return <div key={employee.id} className={selected?styles.selected:''}>
                  <label><input type="checkbox" checked={!!selected} onChange={event=>chooseEmployee(employee,event.target.checked)}/><span><b>{employee.name}</b><small>{employee.jobTitle||employee.role}</small></span></label>
                  {selected&&<div>
                    <input type="number" min="0.01" step=".01" required placeholder="قيمة الهدف"
                      aria-label={`قيمة هدف ${employee.name}`} value={selected.targetValue}
                      onChange={event=>updateAssignment(employee.id,'targetValue',event.target.value)}/>
                    <select aria-label={`المشرف المباشر لـ ${employee.name}`} value={selected.supervisorStaffId}
                      onChange={event=>updateAssignment(employee.id,'supervisorStaffId',event.target.value)}>
                      <option value="">بدون مشرف مباشر</option>
                      {(data?.employees||[]).filter(item=>item.id!==employee.id&&['sales_supervisor','sales_manager','executive_manager'].includes(item.role)).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </div>}
                </div>;
              })}
            </fieldset>
            <label className="mt-field wide">حالة البداية<select value={plan.status} onChange={event=>setPlan({...plan,status:event.target.value})}><option value="active">تفعيل الآن وربط النتائج</option><option value="draft">حفظ كمسودة</option></select></label>
          </>}
          {planError&&<div className={`${styles.formError} mt-field wide`} role="alert">
            <span>!</span><div><b>راجع هذه النقطة</b><p>{planError}</p></div>
          </div>}
        </div>
        <footer className={styles.planFooter}>
          <small>{planStep===3?`${plan.assignments.length} موظف محدد للخطة`:`الخطوة ${planStep} من ${planSteps.length}`}</small>
          <div>
            <button type="button" className="mt-button" onClick={()=>planStep===1?closePlan():(setPlanError(''),setPlanStep(step=>step-1))}>{planStep===1?'إلغاء':'السابق'}</button>
            <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':planStep<3?'التالي':'حفظ الخطة'}</button>
          </div>
        </footer>
      </form>
    </div>}

    {showAnnouncement&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setShowAnnouncement(false)}/>
      <form className="mt-modal" onSubmit={saveAnnouncement}>
        <header><h3>نشر رسالة داخلية</h3><button type="button" onClick={()=>setShowAnnouncement(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field">النوع<select value={announcement.type} onChange={event=>setAnnouncement({...announcement,type:event.target.value})}><option value="notice">تنويه</option><option value="decision">قرار إداري</option><option value="offer">عرض</option><option value="event">فعالية</option><option value="urgent">تنبيه عاجل</option></select></label>
          <label className="mt-field">الأهمية<select value={announcement.priority} onChange={event=>setAnnouncement({...announcement,priority:event.target.value})}><option value="normal">عادي</option><option value="important">مهم</option><option value="urgent">عاجل</option><option value="official">رسمي</option></select></label>
          <label className="mt-field wide">العنوان<input required value={announcement.title} onChange={event=>setAnnouncement({...announcement,title:event.target.value})}/></label>
          <label className="mt-field wide">المحتوى<textarea required rows="6" value={announcement.body} onChange={event=>setAnnouncement({...announcement,body:event.target.value})}/></label>
          <label className="mt-field">بداية الظهور<input type="datetime-local" value={announcement.startsAt} onChange={event=>setAnnouncement({...announcement,startsAt:event.target.value})}/></label>
          <label className="mt-field">نهاية الظهور<input type="datetime-local" value={announcement.endsAt} onChange={event=>setAnnouncement({...announcement,endsAt:event.target.value})}/></label>
          <label className="mt-check"><input type="checkbox" checked={announcement.requiresAck} onChange={event=>setAnnouncement({...announcement,requiresAck:event.target.checked})}/>يتطلب الإقرار بالاطلاع</label>
          <label className="mt-check"><input type="checkbox" checked={announcement.isPinned} onChange={event=>setAnnouncement({...announcement,isPinned:event.target.checked})}/>تثبيت أعلى السجل</label>
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setShowAnnouncement(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ النشر…':'نشر داخل المنشأة'}</button></footer>
      </form>
    </div>}
  </>;
}

function Empty({title,text}){
  return <div className={styles.empty}><span>◎</span><b>{title}</b><p>{text}</p></div>;
}
