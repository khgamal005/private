'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import SalesFollowupModal from './sales-followup-modal';
import dayStyles from './task-calendar-day.module.css';

const DAYS=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FILTERS=[
  ['all','الكل'],
  ['customer_followups','المتابعة فقط'],
  ['interested','مهتم'],
  ['very_interested','مهتم جدًا'],
  ['awaiting_payment','بانتظار الدفع'],
  ['today','اليوم'],
  ['overdue','متأخرة']
];
const EMPTY=[];
const DAY_TASK_PAGE_SIZE=30;
const LEAD_STATUS={
  new:'جديد',
  no_answer:'لم يرد',
  busy:'مشغول',
  follow_up:'متابعة لاحقة',
  interested:'مهتم',
  very_interested:'مهتم جدًا',
  awaiting_payment:'بانتظار الدفع',
  payment_submitted:'أبلغ بالدفع',
  paid:'تم تأكيد الدفع',
  postponed:'مؤجل',
  not_interested:'غير مهتم',
  unqualified:'غير مؤهل',
  wrong_number:'رقم غير صحيح',
  duplicate:'مكرر',
  cancelled:'ملغي'
};
const LEAD_QUALITY={
  unrated:'غير مقيم',
  unqualified:'غير مؤهل',
  weak:'ضعيف',
  qualified:'مؤهل',
  good:'جيد',
  excellent:'ممتاز'
};

function monthStart(value){return new Date(value.getFullYear(),value.getMonth(),1)}
function calendarDays(value){
  const start=monthStart(value);
  const first=new Date(start);
  first.setDate(start.getDate()-start.getDay());
  return Array.from({length:42},(_,index)=>{
    const date=new Date(first);
    date.setDate(first.getDate()+index);
    return date;
  });
}
function sameDay(a,b){return new Date(a).toDateString()===new Date(b).toDateString()}
function state(task){
  if(task.status==='completed')return 'completed';
  if(new Date(task.dueAt)<new Date())return 'overdue';
  if(sameDay(task.dueAt,new Date()))return 'today';
  return 'upcoming';
}
function timingText(task){
  if(task.status==='completed'){
    return task.completionTiming==='late'?'اكتملت متأخرًا':'مكتملة';
  }
  if(state(task)==='overdue')return 'متأخرة';
  if(state(task)==='today')return 'اليوم';
  return 'قادمة';
}
function formatDate(value){
  return new Date(value).toLocaleDateString('ar-SA',{
    weekday:'short',
    day:'numeric',
    month:'short',
    year:'numeric'
  });
}
function formatTime(value){
  return new Date(value).toLocaleTimeString('ar-SA',{
    hour:'2-digit',
    minute:'2-digit'
  });
}
function inputDate(value){
  const date=new Date(value);
  const year=date.getFullYear();
  const month=String(date.getMonth()+1).padStart(2,'0');
  const day=String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}
function number(value){
  return new Intl.NumberFormat('ar-SA').format(Number(value)||0);
}
function percent(value){return `${number(Number(value)||0)}٪`}
function clamp(value){return Math.min(Math.max(Number(value)||0,0),100)}
function duration(value){
  const seconds=Math.round(Math.max(Number(value)||0,0));
  if(seconds<60)return `${number(seconds)} ث`;
  const minutes=Math.floor(seconds/60);
  const remainingSeconds=seconds%60;
  if(minutes<60){
    return `${number(minutes)} د${remainingSeconds?` ${number(remainingSeconds)} ث`:''}`;
  }
  const hours=Math.floor(minutes/60);
  const remainingMinutes=minutes%60;
  return `${number(hours)} س${remainingMinutes?` ${number(remainingMinutes)} د`:''}`;
}

export default function TaskCalendarPage({slug,initialData,embedded=false}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [month,setMonth]=useState(()=>new Date());
  const [filter,setFilter]=useState('all');
  const [mode,setMode]=useState('month');
  const [assignee,setAssignee]=useState('all');
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [showForm,setShowForm]=useState(false);
  const [selected,setSelected]=useState(null);
  const [followupContact,setFollowupContact]=useState(null);
  const [dayPanel,setDayPanel]=useState(null);

  useEffect(()=>setData(initialData),[initialData]);
  useEffect(()=>{
    if(!dayPanel)return undefined;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const closeOnEscape=event=>{
      if(event.key==='Escape')setDayPanel(null);
    };
    window.addEventListener('keydown',closeOnEscape);
    return ()=>{
      document.body.style.overflow=previousOverflow;
      window.removeEventListener('keydown',closeOnEscape);
    };
  },[dayPanel]);

  const tasks=data.tasks||EMPTY;
  const staff=data.staff||EMPTY;
  const contacts=data.contacts||EMPTY;
  const courses=data.courses||EMPTY;
  const courseRuns=data.courseRuns||EMPTY;
  const canWrite=Boolean(data.viewer?.canWriteWork);
  const canWriteCrm=Boolean(data.viewer?.canWriteCrm);
  const viewTeam=Boolean(data.viewer?.viewTeam);

  const summary=useMemo(()=>({
    open:tasks.filter(task=>['todo','in_progress'].includes(task.status)).length,
    overdue:tasks.filter(task=>state(task)==='overdue').length,
    today:tasks.filter(task=>state(task)==='today').length,
    completedLate:tasks.filter(task=>
      task.status==='completed'&&task.completionTiming==='late'
    ).length
  }),[tasks]);

  const filtered=useMemo(()=>tasks.filter(task=>{
    const matchesAssignee=assignee==='all'||task.assignedStaffId===assignee;
    if(!matchesAssignee)return false;
    if(filter==='all')return true;
    if(filter==='customer_followups'){
      return Boolean(task.contactId)&&task.status!=='completed';
    }
    if(['interested','awaiting_payment','very_interested'].includes(filter)){
      return task.contactStatus===filter&&task.status!=='completed';
    }
    return state(task)===filter;
  }),[tasks,filter,assignee]);

  const days=useMemo(()=>calendarDays(month),[month]);
  const grouped=useMemo(()=>days.map(day=>({
    day,
    tasks:filtered.filter(task=>sameDay(task.dueAt,day))
  })),[days,filtered]);
  const agenda=useMemo(()=>[...filtered].sort(
    (a,b)=>new Date(a.dueAt)-new Date(b.dueAt)
  ),[filtered]);

  async function call(action,body){
    const response=await fetch(`/api/tenant/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }

  async function createTask(event){
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await call('create-task',{
        p_tenant_slug:slug,
        p_title:values.title,
        p_description:values.description||null,
        p_assigned_staff_id:values.assigned_staff_id||null,
        p_due_at:new Date(values.due_at).toISOString(),
        p_priority:values.priority||'normal',
        p_opportunity_id:values.opportunity_id||null,
        p_contact_id:values.contact_id||null
      });
      setNotice('تم إنشاء المهمة وإسنادها');
      setShowForm(false);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setSaving(false);
    }
  }

  async function updateStatus(task,status){
    setSaving(true);
    setError('');
    try{
      const result=await call('update-task-status',{
        p_tenant_slug:slug,
        p_task_id:task.id,
        p_status:status
      });
      setNotice(
        status==='completed'
          ?result.completionTiming==='late'
            ?'تم إتمام المهمة وتسجيلها بعد الموعد'
            :'تم إتمام المهمة في الموعد'
          :'تم تحديث حالة المهمة'
      );
      setSelected(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setSaving(false);
    }
  }

  function openTask(task){
    const contact=task.contactId
      ?contacts.find(item=>item.id===task.contactId)
      :null;
    if(contact&&canWriteCrm&&task.status!=='completed'){
      setFollowupContact(contact);
      return;
    }
    setSelected(task);
  }

  async function openDay(day){
    const key=inputDate(day);
    const dayTasks=tasks.filter(task=>
      sameDay(task.dueAt,day)
      &&(assignee==='all'||task.assignedStaffId===assignee)
    );
    setDayPanel({
      key,
      day:new Date(day),
      tasks:dayTasks,
      insight:null,
      loading:true,
      error:''
    });
    try{
      const insight=await call('calendar-day',{
        p_tenant_slug:slug,
        p_day:key,
        p_task_ids:dayTasks.map(task=>task.id)
      });
      const dayTasksById=new Map(dayTasks.map(task=>[task.id,task]));
      const verifiedTasks=Array.isArray(insight?.tasks)
        ?insight.tasks.map(task=>({
          ...(dayTasksById.get(task.id)||{}),
          ...task
        }))
        :dayTasks;
      setDayPanel(current=>current?.key===key?{
        ...current,
        tasks:verifiedTasks,
        insight,
        loading:false,
        error:''
      }:current);
    }catch(err){
      setDayPanel(current=>current?.key===key?{
        ...current,
        loading:false,
        error:err instanceof Error?err.message:'تعذر تحميل تفاصيل اليوم'
      }:current);
    }
  }

  return <main className={`role-calendar-page ${embedded?'is-embedded':''}`} dir="rtl">
    <header className="mt-page-head">
      <div>
        <small>V2 TASKS & CALENDAR</small>
        <h2>المهام والتقويم</h2>
        <p>{viewTeam?'متابعة مهام الفريق كاملة':'مهامك المسندة'} · اضغط متابعة العميل لتسجيل النتيجة وتحديد الإجراء التالي مباشرة.</p>
      </div>
      {canWrite&&<div className="mt-page-actions">
        <button type="button" className="mt-button primary" onClick={()=>setShowForm(true)}>+ مهمة جديدة</button>
      </div>}
    </header>

    {tasks.some(item=>item.demo)&&<section className="mt-data-note warning">
      <div><b>المهام الحالية تشمل بيانات تجريبية</b><p>هي مهام مرتبطة بفرص ريف التجريبية، ومميزة داخل قاعدة البيانات.</p></div>
      <span>DEMO</span>
    </section>}

    {error&&<div className="calendar-alert error">{error}</div>}
    {notice&&<div className="calendar-alert success">{notice}</div>}

    <section className="calendar-summary-grid">
      <button onClick={()=>setFilter('all')} className={filter==='all'?'active':''}><span>المهام المفتوحة</span><b>{summary.open}</b><small>جميع المهام الجارية</small></button>
      <button onClick={()=>setFilter('overdue')} className={`danger ${filter==='overdue'?'active':''}`}><span>المتأخرة</span><b>{summary.overdue}</b><small>تحتاج إجراءً الآن</small></button>
      <button onClick={()=>setFilter('today')} className={`warning ${filter==='today'?'active':''}`}><span>مهام اليوم</span><b>{summary.today}</b><small>مطلوبة قبل نهاية اليوم</small></button>
      <button onClick={()=>setFilter('completed')} className={filter==='completed'?'active':''}><span>اكتملت متأخرًا</span><b>{summary.completedLate}</b><small>مسجلة لقياس الأداء</small></button>
    </section>

    <section className="calendar-controlbar">
      <div className="calendar-month-switch">
        <button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}>‹</button>
        <button onClick={()=>setMonth(new Date())}>اليوم</button>
        <button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}>›</button>
      </div>
      <h2>{MONTHS[month.getMonth()]} {month.getFullYear()}</h2>
      <div className="calendar-view-controls">
        {viewTeam&&<select value={assignee} onChange={event=>setAssignee(event.target.value)}>
          <option value="all">كل الفريق</option>
          {staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}
        </select>}
        <div className="calendar-mode-toggle">
          <button className={mode==='month'?'active':''} onClick={()=>setMode('month')}>الشهر</button>
          <button className={mode==='agenda'?'active':''} onClick={()=>setMode('agenda')}>القائمة</button>
        </div>
      </div>
    </section>

    <section className="calendar-filterbar">
      {FILTERS.map(([key,label])=><button
        key={key}
        className={filter===key?'active':''}
        onClick={()=>setFilter(key)}
      >{label}</button>)}
    </section>

    {mode==='month'?<>
      <section className="role-calendar-weekdays">
        {DAYS.map(day=><span key={day}>{day}</span>)}
      </section>
      <section className="role-calendar-grid">
        {grouped.map(({day,tasks:dayTasks})=><article
          className={`${day.getMonth()!==month.getMonth()?'outside':''} ${sameDay(day,new Date())?'today':''}`}
          key={day.toISOString()}
        >
          <header><b>{day.getDate()}</b>{dayTasks.length>0&&<span>{dayTasks.length}</span>}</header>
          <div>
            {dayTasks.slice(0,4).map(task=><button
              className={`role-calendar-task ${state(task)}`}
              key={task.id}
              onClick={()=>openTask(task)}
            >
              <strong>{task.title}</strong>
              <small>{formatTime(task.dueAt)} · {task.contactName||task.assigneeName||'مهمة تشغيلية'}</small>
            </button>)}
            {dayTasks.length>4&&<button
              type="button"
              className={`more-tasks ${dayStyles.moreButton}`}
              onClick={()=>openDay(day)}
              aria-label={`عرض كل مهام يوم ${formatDate(day)}`}
            >+ {dayTasks.length-4} أخرى</button>}
          </div>
        </article>)}
      </section>
    </>:<section className="role-calendar-agenda">
      {agenda.map(task=><article className={state(task)} key={task.id} onClick={()=>openTask(task)}>
        <time><span>{formatDate(task.dueAt)}</span><b>{formatTime(task.dueAt)}</b></time>
        <div className="agenda-main">
          <strong>{task.title}</strong>
          <p>{task.description||task.contactCourseName||'مهمة تشغيلية'}</p>
          <small>
            {task.assigneeName||'غير مسند'}
            {task.contactName?` · ${task.contactName}`:''}
            {task.contactPhone?` · ${task.contactPhone}`:''}
          </small>
          {task.contactStatus&&<div className="agenda-lead-context">
            <span>{LEAD_STATUS[task.contactStatus]||task.contactStatus}</span>
            <span>{LEAD_QUALITY[task.contactQuality]||'غير مقيم'}</span>
          </div>}
        </div>
        <div className="agenda-badges"><span className={`timing ${state(task)}`}>{timingText(task)}</span></div>
        {task.status!=='completed'&&canWrite&&<button
          className="complete-inline"
          onClick={event=>{event.stopPropagation();updateStatus(task,'completed')}}
          disabled={saving}
        >إتمام</button>}
      </article>)}
      {!agenda.length&&<div className="calendar-empty">لا توجد مهام مطابقة لهذا الاختيار.</div>}
    </section>}

    {showForm&&<div className="calendar-modal-layer">
      <button className="calendar-modal-backdrop" onClick={()=>!saving&&setShowForm(false)} aria-label="إغلاق"/>
      <form className="calendar-task-form" onSubmit={createTask}>
        <header>
          <div><small>مهمة جديدة</small><h2>إضافة مهمة إلى التقويم</h2></div>
          <button type="button" onClick={()=>setShowForm(false)}>×</button>
        </header>
        <div className="calendar-form-grid">
          <label className="wide">عنوان المهمة<input name="title" required/></label>
          <label>المسند إليه<select name="assigned_staff_id"><option value="">أنا / غير مسند</option>{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>الأولوية<select name="priority" defaultValue="normal"><option value="low">منخفضة</option><option value="normal">عادية</option><option value="high">عالية</option><option value="urgent">عاجلة</option></select></label>
          <label>الموعد<input name="due_at" required type="datetime-local"/></label>
          <label>العميل<select name="contact_id"><option value="">غير مرتبط</option>{contacts.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="wide">التفاصيل<textarea name="description" rows="4"/></label>
          {error&&<div className="calendar-alert error wide">{error}</div>}
        </div>
        <footer>
          <button type="button" onClick={()=>setShowForm(false)}>إلغاء</button>
          <button className="calendar-primary" disabled={saving}>{saving?'جارٍ الحفظ…':'حفظ المهمة'}</button>
        </footer>
      </form>
    </div>}

    {selected&&<div className="calendar-modal-layer">
      <button className="calendar-modal-backdrop" onClick={()=>setSelected(null)} aria-label="إغلاق"/>
      <section className="calendar-task-details">
        <header>
          <div><span className={`timing ${state(selected)}`}>{timingText(selected)}</span><h2>{selected.title}</h2></div>
          <button onClick={()=>setSelected(null)}>×</button>
        </header>
        <dl>
          <div><dt>المسند إليه</dt><dd>{selected.assigneeName||'—'}</dd></div>
          <div><dt>الموعد</dt><dd>{formatDate(selected.dueAt)} · {formatTime(selected.dueAt)}</dd></div>
          <div><dt>الحالة</dt><dd>{selected.status==='completed'?'مكتملة':selected.status==='in_progress'?'جارية':'مفتوحة'}</dd></div>
          <div><dt>الأولوية</dt><dd>{selected.priority}</dd></div>
        </dl>
        {selected.description&&<p>{selected.description}</p>}
        {selected.contactName&&<aside className="calendar-customer-card">
          <b>{selected.contactName}</b>
          {selected.contactPhone&&<a href={`tel:${String(selected.contactPhone).replace(/\D/g,'')}`}>{selected.contactPhone}</a>}
          <span>{selected.contactCourseName||'الدورة غير محددة'}</span>
          <small>
            {selected.contactStatus?LEAD_STATUS[selected.contactStatus]||selected.contactStatus:'الحالة غير محددة'}
            {' · '}
            {selected.contactQuality?LEAD_QUALITY[selected.contactQuality]||selected.contactQuality:'غير مقيم'}
          </small>
          {selected.contactLatestNote&&<div className="calendar-customer-latest-note">
            <strong>آخر ملاحظة</strong>
            <p>{selected.contactLatestNote}</p>
            {selected.contactLatestNoteAt&&<time>
              {formatDate(selected.contactLatestNoteAt)} · {formatTime(selected.contactLatestNoteAt)}
            </time>}
          </div>}
        </aside>}
        <footer>
          <button onClick={()=>setSelected(null)}>إغلاق</button>
          {selected.status==='todo'&&canWrite&&<button onClick={()=>updateStatus(selected,'in_progress')} disabled={saving}>بدء التنفيذ</button>}
          {selected.status!=='completed'&&canWrite&&<button className="calendar-primary" onClick={()=>updateStatus(selected,'completed')} disabled={saving}>إتمام المهمة</button>}
        </footer>
      </section>
    </div>}

    {dayPanel&&<CalendarDayDetails
      key={dayPanel.key}
      panel={dayPanel}
      canWriteCrm={canWriteCrm}
      onClose={()=>setDayPanel(null)}
      onRetry={()=>openDay(dayPanel.day)}
      onOpenTask={task=>{
        setDayPanel(null);
        openTask(task);
      }}
    />}

    {followupContact&&<SalesFollowupModal
      slug={slug}
      contact={followupContact}
      courses={courses}
      courseRuns={courseRuns}
      onClose={()=>setFollowupContact(null)}
      onSaved={followupMessage=>{
        setNotice(followupMessage);
        setFollowupContact(null);
        router.refresh();
      }}
    />}
  </main>;
}

function CalendarDayDetails({
  panel,
  canWriteCrm,
  onClose,
  onRetry,
  onOpenTask
}){
  const [taskFilter,setTaskFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [taskPage,setTaskPage]=useState(1);
  const closeButtonRef=useRef(null);
  const taskListRef=useRef(null);
  useEffect(()=>closeButtonRef.current?.focus(),[]);
  const summary=panel.insight?.summary;
  const yeastar=panel.insight?.yeastar;
  const tasks=panel.tasks||EMPTY;
  const visibleTasks=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase('ar');
    return tasks.filter(task=>{
      const taskState=state(task);
      const matchesFilter=taskFilter==='all'
        ||(taskFilter==='completed'&&task.status==='completed')
        ||(taskFilter==='open'&&['todo','in_progress'].includes(task.status))
        ||(taskFilter==='overdue'&&taskState==='overdue');
      if(!matchesFilter)return false;
      if(!needle)return true;
      return [
        task.title,
        task.contactName,
        task.contactPhone,
        task.assigneeName,
        task.contactCourseName
      ].some(value=>String(value||'').toLocaleLowerCase('ar').includes(needle));
    });
  },[tasks,taskFilter,query]);
  const pageCount=Math.max(1,Math.ceil(visibleTasks.length/DAY_TASK_PAGE_SIZE));
  const currentPage=Math.min(taskPage,pageCount);
  const pageStart=(currentPage-1)*DAY_TASK_PAGE_SIZE;
  const pageTasks=useMemo(
    ()=>visibleTasks.slice(pageStart,pageStart+DAY_TASK_PAGE_SIZE),
    [visibleTasks,pageStart]
  );
  const metric=value=>panel.loading||!summary?'—':number(value);
  const customerRate=summary?.customerCompletionRate;
  const yeastarValue=panel.loading||!yeastar
    ?'—'
    :yeastar.available?duration(yeastar.talkSeconds):'غير متاح';
  function selectTaskPage(nextPage){
    setTaskPage(Math.min(Math.max(nextPage,1),pageCount));
    taskListRef.current?.scrollTo({top:0,behavior:'smooth'});
  }

  return <div className={dayStyles.layer}>
    <button
      type="button"
      className={dayStyles.backdrop}
      onClick={onClose}
      aria-label="إغلاق تفاصيل اليوم"
    />
    <section
      className={dayStyles.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="calendar-day-details-title"
      aria-busy={panel.loading}
    >
      <header className={dayStyles.header}>
        <div>
          <small>DAILY TASK INTELLIGENCE</small>
          <h2 id="calendar-day-details-title">تفاصيل مهام {formatDate(panel.day)}</h2>
          <p>كل المهام ضمن نطاقك مع حالة الإنجاز ومكالمات العملاء الموثقة.</p>
        </div>
        <button
          type="button"
          ref={closeButtonRef}
          onClick={onClose}
          aria-label="إغلاق"
        >×</button>
      </header>

      <div className={dayStyles.body}>
        {panel.error&&<div className={dayStyles.error}>
          <div>
            <b>تعذر تحميل مؤشرات الأداء الموثوقة</b>
            <span>المهام ظاهرة، لكن لن نعرض أرقامًا تقريبية بدل بيانات قاعدة النظام وYeastar.</span>
          </div>
          <button type="button" onClick={onRetry}>إعادة المحاولة</button>
        </div>}

        <section className={dayStyles.metrics} aria-label="ملخص مهام اليوم">
          <DayMetric
            label="إجمالي المهام"
            value={metric(summary?.totalTasks)}
            note="بعد استبعاد الملغي"
            tone="navy"
          />
          <DayMetric
            label="تم إنجازه"
            value={metric(summary?.completedTasks)}
            note={!summary
              ?panel.loading?'جارٍ التحقق…':'غير متاح'
              :`${number(summary.onTimeTasks)} في الموعد`}
            tone="green"
          />
          <DayMetric
            label="المهام المتبقية"
            value={metric(summary?.openTasks)}
            note={!summary
              ?panel.loading?'جارٍ التحقق…':'غير متاح'
              :`${number(summary.overdueTasks)} متأخرة`}
            tone="amber"
          />
          <article className={`${dayStyles.metric} ${dayStyles.rateMetric}`}>
            <div
              className={dayStyles.rateRing}
              style={{'--task-rate':`${clamp(customerRate)}%`}}
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={!summary?undefined:clamp(customerRate)}
            ><b>{panel.loading||!summary?'—':percent(customerRate)}</b></div>
            <div>
              <span>إغلاق مهام العملاء</span>
              <small>{!summary
                ?panel.loading?'جارٍ التحقق…':'غير متاح'
                :`${number(summary.completedCustomerTasks)} من ${number(summary.customerTasks)} مهمة عميل`}</small>
            </div>
          </article>
          <article className={`${dayStyles.metric} ${dayStyles.callMetric}`}>
            <span className={dayStyles.callIcon}>☎</span>
            <div>
              <span>دقائق Yeastar للمهام المنجزة</span>
              <b>{yeastarValue}</b>
              <small>{yeastarNote(yeastar,panel.loading)}</small>
            </div>
            {yeastar?.available&&<em>{number(yeastar.matchedCalls)} مكالمة مجابة</em>}
          </article>
        </section>

        <section className={dayStyles.listPanel}>
          <header className={dayStyles.listHeader}>
            <div>
              <small>مهام اليوم</small>
              <h3>{number(visibleTasks.length)} مهمة مطابقة</h3>
            </div>
            <label className={dayStyles.search}>
              <span>⌕</span>
              <input
                value={query}
                onChange={event=>{
                  setQuery(event.target.value);
                  setTaskPage(1);
                }}
                placeholder="ابحث باسم العميل أو المهمة أو الجوال"
                aria-label="البحث في مهام اليوم"
              />
            </label>
          </header>
          <nav className={dayStyles.filters} aria-label="تصفية مهام اليوم">
            {[
              ['all','الكل'],
              ['completed','تم إنجازه'],
              ['open','لم يكتمل'],
              ['overdue','متأخر']
            ].map(([key,label])=><button
              type="button"
              key={key}
              className={taskFilter===key?dayStyles.active:''}
              onClick={()=>{
                setTaskFilter(key);
                setTaskPage(1);
              }}
            >{label}</button>)}
          </nav>
          <div className={dayStyles.taskList} ref={taskListRef}>
            {pageTasks.map(task=><DayTaskRow
              key={task.id}
              task={task}
              canWriteCrm={canWriteCrm}
              onOpen={()=>onOpenTask(task)}
            />)}
            {!visibleTasks.length&&<div className={dayStyles.empty}>
              <span>✓</span>
              <b>لا توجد مهام مطابقة</b>
              <p>غيّر التصفية أو عبارة البحث لعرض مهام أخرى في هذا اليوم.</p>
            </div>}
          </div>
          {visibleTasks.length>DAY_TASK_PAGE_SIZE&&<footer
            className={dayStyles.pagination}
            aria-label="صفحات مهام اليوم"
          >
            <button
              type="button"
              onClick={()=>selectTaskPage(currentPage-1)}
              disabled={currentPage===1}
            >السابق</button>
            <div aria-live="polite">
              <b>صفحة {number(currentPage)} من {number(pageCount)}</b>
              <small>
                عرض {number(pageStart+1)}–{number(pageStart+pageTasks.length)} من {number(visibleTasks.length)}
              </small>
            </div>
            <button
              type="button"
              onClick={()=>selectTaskPage(currentPage+1)}
              disabled={currentPage===pageCount}
            >التالي</button>
          </footer>}
        </section>
      </div>
    </section>
  </div>;
}

function DayMetric({label,value,note,tone}){
  return <article className={`${dayStyles.metric} ${dayStyles[tone]}`}>
    <span>{label}</span><b>{value}</b><small>{note}</small>
  </article>;
}

function DayTaskRow({task,canWriteCrm,onOpen}){
  const taskState=state(task);
  const talkSeconds=Number(task.yeastarTalkSeconds)||0;
  return <article className={`${dayStyles.taskRow} ${dayStyles[`task_${taskState}`]}`}>
    <span className={dayStyles.statusIcon}>{task.status==='completed'?'✓':taskState==='overdue'?'!':'•'}</span>
    <div className={dayStyles.taskMain}>
      <div>
        <strong>{task.title}</strong>
        <span className={dayStyles.status}>{dayTaskStatusText(task)}</span>
      </div>
      <p>{task.contactName||task.description||'مهمة تشغيلية غير مرتبطة بعميل'}</p>
      <small>
        {formatTime(task.dueAt)}
        {task.assigneeName?` · ${task.assigneeName}`:''}
        {task.contactPhone?` · ${task.contactPhone}`:''}
      </small>
      {task.contactStatus&&<div className={dayStyles.context}>
        <span>{LEAD_STATUS[task.contactStatus]||task.contactStatus}</span>
        <span>{LEAD_QUALITY[task.contactQuality]||'غير مقيم'}</span>
        {task.contactCourseName&&<span>{task.contactCourseName}</span>}
      </div>}
    </div>
    <div className={dayStyles.taskCall}>
      <span>وقت الحديث</span>
      <b>{talkSeconds?duration(talkSeconds):'—'}</b>
      {talkSeconds>0&&<small>{number(task.yeastarAnsweredCalls)} مكالمات</small>}
    </div>
    <button type="button" className={dayStyles.openTask} onClick={onOpen}>
      {task.status==='completed'?'عرض التفاصيل':task.contactId&&canWriteCrm?'تسجيل متابعة':'فتح المهمة'}
    </button>
  </article>;
}

function dayTaskStatusText(task){
  if(task.status==='cancelled')return 'ملغاة';
  if(task.status==='completed')return timingText(task);
  if(state(task)==='overdue')return 'لم تكتمل · متأخرة';
  if(task.status==='in_progress')return 'قيد التنفيذ';
  return 'لم تكتمل';
}

function yeastarNote(yeastar,loading){
  if(loading)return 'جارٍ مطابقة سجلات المكالمات…';
  if(!yeastar)return 'تعذر التحقق من بيانات Yeastar';
  if(yeastar.status==='addon_not_enabled')return 'إضافة Yeastar غير مفعلة للمنشأة';
  if(yeastar.status==='not_configured')return 'أكمل ربط الجهاز والتحويلات أولًا';
  if(yeastar.status==='sync_unavailable')return 'ربط Yeastar غير نشط أو يحتاج مراجعة';
  if(yeastar.status==='crm_permission_required')return 'لا توجد صلاحية لعرض بيانات العملاء والمكالمات';
  if(yeastar.status==='degraded'){
    return `${number(yeastar.matchedCompletedTasks)} من المهام لها مكالمة · الربط يحتاج مراجعة`;
  }
  return `${number(yeastar.matchedCompletedTasks)} من المهام المنجزة لها مكالمة فعلية`;
}
