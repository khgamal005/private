'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const DAYS=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FILTERS=[
  ['all','الكل'],
  ['overdue','متأخرة'],
  ['today','اليوم'],
  ['upcoming','قادمة'],
  ['completed','مكتملة']
];
const EMPTY=[];

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

  useEffect(()=>setData(initialData),[initialData]);

  const tasks=data.tasks||EMPTY;
  const staff=data.staff||EMPTY;
  const contacts=data.contacts||EMPTY;
  const opportunities=(data.opportunities||EMPTY).filter(item=>item.status==='open');
  const canWrite=Boolean(data.viewer?.canWriteWork);
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
    if(filter==='completed')return task.status==='completed';
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

  return <main className={`role-calendar-page ${embedded?'is-embedded':''}`} dir="rtl">
    <header className="mt-page-head">
      <div>
        <small>V2 TASKS & CALENDAR</small>
        <h2>المهام والتقويم</h2>
        <p>{viewTeam?'متابعة مهام الفريق كاملة':'مهامك المسندة'} · كل متابعة مبيعات تظهر هنا تلقائيًا.</p>
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
              onClick={()=>setSelected(task)}
            >
              <strong>{task.title}</strong>
              <small>{formatTime(task.dueAt)} · {task.assigneeName||'غير مسند'}</small>
            </button>)}
            {dayTasks.length>4&&<button className="more-tasks">+ {dayTasks.length-4} أخرى</button>}
          </div>
        </article>)}
      </section>
    </>:<section className="role-calendar-agenda">
      {agenda.map(task=><article className={state(task)} key={task.id} onClick={()=>setSelected(task)}>
        <time><span>{formatDate(task.dueAt)}</span><b>{formatTime(task.dueAt)}</b></time>
        <div className="agenda-main">
          <strong>{task.title}</strong>
          <p>{task.description||task.opportunityTitle||'مهمة تشغيلية'}</p>
          <small>{task.assigneeName||'غير مسند'}{task.contactName?` · ${task.contactName}`:''}</small>
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
          <label>الفرصة<select name="opportunity_id"><option value="">غير مرتبطة</option>{opportunities.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
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
        {selected.contactName&&<aside><b>{selected.contactName}</b><small>{selected.opportunityTitle||'مهمة عميل'}</small></aside>}
        <footer>
          <button onClick={()=>setSelected(null)}>إغلاق</button>
          {selected.status==='todo'&&canWrite&&<button onClick={()=>updateStatus(selected,'in_progress')} disabled={saving}>بدء التنفيذ</button>}
          {selected.status!=='completed'&&canWrite&&<button className="calendar-primary" onClick={()=>updateStatus(selected,'completed')} disabled={saving}>إتمام المهمة</button>}
        </footer>
      </section>
    </div>}
  </main>;
}
