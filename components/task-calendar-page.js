'use client';

import {useEffect,useMemo,useState} from 'react';

const DAYS=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FILTERS=[
  ['all','الكل'],['overdue','متأخرة'],['today','اليوم'],['upcoming','قادمة'],['completed','مكتملة']
];

function localInput(value){
  const date=new Date(value);
  date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
  return date.toISOString().slice(0,16);
}
function monthStart(value){return new Date(value.getFullYear(),value.getMonth(),1)}
function monthEnd(value){return new Date(value.getFullYear(),value.getMonth()+1,0,23,59,59,999)}
function calendarDays(value){
  const start=monthStart(value);const first=new Date(start);first.setDate(start.getDate()-start.getDay());
  return Array.from({length:42},(_,index)=>{const date=new Date(first);date.setDate(first.getDate()+index);return date});
}
function sameDay(a,b){return new Date(a).toDateString()===new Date(b).toDateString()}
function timingText(task){
  if(task.timing_state==='overdue')return 'متأخرة';
  if(task.timing_state==='today')return 'اليوم';
  if(task.timing_state==='late')return 'اكتملت بعد الموعد';
  if(task.timing_state==='completed_on_time'||task.status==='completed')return 'اكتملت في الموعد';
  return 'قادمة';
}
function formatDate(value){return new Date(value).toLocaleDateString('ar-SA',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}
function formatTime(value){return new Date(value).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})}

async function api(action,{method='GET',query={},body}={}){
  const qs=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==null&&value!==undefined&&value!=='')).toString();
  const response=await fetch('/api/operations/'+action+(qs?'?'+qs:''),{
    method,credentials:'include',headers:body?{'content-type':'application/json'}:undefined,
    body:body?JSON.stringify(body):undefined,cache:'no-store'
  });
  const payload=await response.json().catch(()=>({error:'تعذر قراءة استجابة النظام'}));
  if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ الطلب');
  return payload;
}

export default function TaskCalendarPage({slug,embedded=false}){
  const [context,setContext]=useState(null);
  const [tasks,setTasks]=useState([]);
  const [month,setMonth]=useState(()=>new Date());
  const [scope,setScope]=useState('mine');
  const [filter,setFilter]=useState('all');
  const [mode,setMode]=useState('month');
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [showForm,setShowForm]=useState(false);
  const [selected,setSelected]=useState(null);
  const [form,setForm]=useState(()=>({
    title:'',description:'',assignedTo:'',startsAt:localInput(new Date()),
    dueAt:localInput(new Date(Date.now()+86400000)),recurrenceType:'none',
    recurrenceInterval:1,recurrenceEndAt:localInput(new Date(Date.now()+30*86400000))
  }));

  const permissions=context?.permissions||{};
  const members=context?.members||[];
  const user=context?.user||{};

  async function bootstrap(){
    try{
      setError('');
      const data=await api('bootstrap',{query:{tenantSlug:slug}});
      setContext(data);
    }catch(err){setError(err.message)}
  }
  async function loadCalendar(){
    try{
      setLoading(true);setError('');
      const data=await api('calendar',{query:{tenantSlug:slug,from:monthStart(month).toISOString(),to:monthEnd(month).toISOString(),scope}});
      setTasks(Array.isArray(data)?data:[]);
    }catch(err){setError(err.message)}finally{setLoading(false)}
  }
  useEffect(()=>{bootstrap()},[slug]);
  useEffect(()=>{if(context)loadCalendar()},[context,month,scope]);

  const summary=useMemo(()=>({
    open:tasks.filter(task=>['open','in_progress'].includes(task.status)).length,
    overdue:tasks.filter(task=>task.timing_state==='overdue').length,
    today:tasks.filter(task=>task.timing_state==='today').length,
    completedLate:tasks.filter(task=>task.timing_state==='late').length
  }),[tasks]);

  const filtered=useMemo(()=>tasks.filter(task=>{
    if(filter==='all')return true;
    if(filter==='completed')return task.status==='completed';
    return task.timing_state===filter;
  }),[tasks,filter]);

  const days=useMemo(()=>calendarDays(month),[month]);
  const grouped=useMemo(()=>days.map(day=>({day,tasks:filtered.filter(task=>sameDay(task.due_at,day))})),[days,filtered]);
  const agenda=useMemo(()=>[...filtered].sort((a,b)=>new Date(a.due_at)-new Date(b.due_at)),[filtered]);

  async function createTask(event){
    event.preventDefault();
    try{
      setSaving(true);setError('');setNotice('');
      const result=await api('task',{method:'POST',body:{
        tenantSlug:slug,title:form.title,description:form.description,
        assignedTo:form.assignedTo||null,startsAt:new Date(form.startsAt).toISOString(),
        dueAt:new Date(form.dueAt).toISOString(),recurrenceType:form.recurrenceType,
        recurrenceInterval:Number(form.recurrenceInterval||1),
        recurrenceEndAt:form.recurrenceType==='none'?null:new Date(form.recurrenceEndAt).toISOString()
      }});
      setNotice(result.created_count>1?'تم إنشاء '+result.created_count+' مهام متكررة':'تم إنشاء المهمة');
      setShowForm(false);
      setForm(previous=>({...previous,title:'',description:'',assignedTo:''}));
      await loadCalendar();
    }catch(err){setError(err.message)}finally{setSaving(false)}
  }

  async function completeTask(task){
    if(task.status==='completed')return;
    try{
      setSaving(true);setError('');
      const result=await api('complete',{method:'POST',body:{tenantSlug:slug,taskId:task.id}});
      setNotice(result.completion_timing==='late'?'تم إتمام المهمة وتسجيلها بعد الموعد':'تم إتمام المهمة في الموعد');
      setSelected(null);await loadCalendar();
    }catch(err){setError(err.message)}finally{setSaving(false)}
  }

  return <main className={`role-calendar-page ${embedded?'is-embedded':''}`} dir="rtl">
    {embedded?<header className="mt-page-head">
      <div><small>TASKS & CALENDAR</small><h2>المهام والتقويم</h2><p>{context?.roleLabel||'مستخدم'} · جميع المهام الفردية والمشتركة في تقويم واحد.</p></div>
      <div className="mt-page-actions"><button type="button" className="mt-button" onClick={loadCalendar} disabled={loading}>تحديث</button><button type="button" className="mt-button primary" onClick={()=>setShowForm(true)}>+ مهمة جديدة</button></div>
    </header>:<header className="role-calendar-topbar">
      <div className="calendar-title-block">
        <a href={'/tenant/'+encodeURIComponent(slug)} className="calendar-back" aria-label="العودة إلى المنصة">→</a>
        <div><small>MARKTONE TASKS</small><h1>تقويم المهام</h1><p>{context?.roleLabel||'مستخدم'} · المهام المسندة والمواعيد المتكررة</p></div>
      </div>
      <div className="calendar-top-actions">
        <button type="button" className="calendar-refresh" onClick={loadCalendar} disabled={loading}>تحديث</button>
        <button type="button" className="calendar-primary" onClick={()=>setShowForm(true)}>+ مهمة جديدة</button>
      </div>
    </header>}

    {error&&<div className="calendar-alert error">{error}</div>}
    {notice&&<div className="calendar-alert success">{notice}</div>}

    <section className="calendar-summary-grid">
      <button onClick={()=>setFilter('all')} className={filter==='all'?'active':''}><span>المهام المفتوحة</span><b>{summary.open}</b><small>جميع المهام الجارية</small></button>
      <button onClick={()=>setFilter('overdue')} className={'danger '+(filter==='overdue'?'active':'')}><span>المتأخرة</span><b>{summary.overdue}</b><small>تظل ظاهرة بعد الموعد</small></button>
      <button onClick={()=>setFilter('today')} className={'warning '+(filter==='today'?'active':'')}><span>مهام اليوم</span><b>{summary.today}</b><small>مطلوبة قبل نهاية اليوم</small></button>
      <button onClick={()=>setFilter('completed')} className={filter==='completed'?'active':''}><span>اكتملت متأخرًا</span><b>{summary.completedLate}</b><small>مسجلة لقياس الأداء</small></button>
    </section>

    <section className="calendar-controlbar">
      <div className="calendar-month-switch"><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}>‹</button><button onClick={()=>setMonth(new Date())}>اليوم</button><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}>›</button></div>
      <h2>{MONTHS[month.getMonth()]} {month.getFullYear()}</h2>
      <div className="calendar-view-controls">
        <select value={scope} onChange={event=>setScope(event.target.value)}>
          <option value="mine">مهامي</option>
          {permissions.viewTeam&&<option value="team">مهام فريقي</option>}
          {user.role_code==='admin'&&<option value="all">كل المهام</option>}
        </select>
        <div className="calendar-mode-toggle"><button className={mode==='month'?'active':''} onClick={()=>setMode('month')}>الشهر</button><button className={mode==='agenda'?'active':''} onClick={()=>setMode('agenda')}>القائمة</button></div>
      </div>
    </section>

    <section className="calendar-filterbar">{FILTERS.map(([key,label])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label}</button>)}</section>

    {loading?<div className="calendar-loading">جارٍ تحميل المهام…</div>:mode==='month'?<>
      <div className="role-calendar-weekdays">{DAYS.map(day=><span key={day}>{day}</span>)}</div>
      <div className="role-calendar-grid">{grouped.map(({day,tasks:dayTasks})=><article key={day.toISOString()} className={(day.getMonth()!==month.getMonth()?'outside ':'')+(sameDay(day,new Date())?'today':'')}>
        <header><b>{day.getDate()}</b>{dayTasks.length>0&&<span>{dayTasks.length}</span>}</header>
        <div>{dayTasks.slice(0,4).map(task=><button key={task.id} className={'role-calendar-task '+task.timing_state} onClick={()=>setSelected(task)}>
          <strong>{task.title}</strong><small>{formatTime(task.due_at)}</small>{task.recurrence_type!=='none'&&<em>↻</em>}
        </button>)}{dayTasks.length>4&&<button className="more-tasks" onClick={()=>setMode('agenda')}>+{dayTasks.length-4} أخرى</button>}</div>
      </article>)}</div>
    </>:<div className="role-calendar-agenda">{agenda.length?agenda.map(task=><article key={task.id} className={task.timing_state} onClick={()=>setSelected(task)}>
      <time><span>{formatDate(task.due_at)}</span><b>{formatTime(task.due_at)}</b></time>
      <div className="agenda-main"><strong>{task.title}</strong><p>{task.description||task.lead?.customer_name||'مهمة تشغيلية'}</p><small>{task.assigned_name||''}{task.lead?.program_name?' · '+task.lead.program_name:''}</small></div>
      <div className="agenda-badges"><span className={'timing '+task.timing_state}>{timingText(task)}</span>{task.recurrence_type!=='none'&&<span className="recurring">متكررة ↻</span>}</div>
      {task.status!=='completed'&&<button className="complete-inline" onClick={event=>{event.stopPropagation();completeTask(task)}} disabled={saving}>إتمام</button>}
    </article>):<div className="calendar-empty">لا توجد مهام مطابقة لهذا الاختيار.</div>}</div>}

    {showForm&&<div className="calendar-modal-layer"><button className="calendar-modal-backdrop" onClick={()=>setShowForm(false)} aria-label="إغلاق"/><form className="calendar-task-form" onSubmit={createTask}>
      <header><div><small>مهمة جديدة</small><h2>إضافة مهمة إلى التقويم</h2></div><button type="button" onClick={()=>setShowForm(false)}>×</button></header>
      <div className="calendar-form-grid">
        <label className="wide">عنوان المهمة<input required value={form.title} onChange={event=>setForm({...form,title:event.target.value})}/></label>
        {permissions.assignOthers&&<label>المسند إليه<select value={form.assignedTo} onChange={event=>setForm({...form,assignedTo:event.target.value})}><option value="">أنا</option>{members.filter(member=>member.user_id!==user.user_id).map(member=><option value={member.user_id} key={member.user_id}>{member.display_name||member.email}</option>)}</select></label>}
        <label>تبدأ في<input type="datetime-local" value={form.startsAt} onChange={event=>setForm({...form,startsAt:event.target.value})}/></label>
        <label>تنتهي في<input required type="datetime-local" value={form.dueAt} onChange={event=>setForm({...form,dueAt:event.target.value})}/></label>
        <label>التكرار<select value={form.recurrenceType} onChange={event=>setForm({...form,recurrenceType:event.target.value})}><option value="none">بدون تكرار</option><option value="daily">يومي</option><option value="weekly">أسبوعي</option><option value="monthly">شهري</option></select></label>
        {form.recurrenceType!=='none'&&<><label>يتكرر كل<input type="number" min="1" max="52" value={form.recurrenceInterval} onChange={event=>setForm({...form,recurrenceInterval:event.target.value})}/></label><label>حتى تاريخ<input required type="datetime-local" value={form.recurrenceEndAt} onChange={event=>setForm({...form,recurrenceEndAt:event.target.value})}/></label></>}
        <label className="wide">التفاصيل<textarea rows="4" value={form.description} onChange={event=>setForm({...form,description:event.target.value})}/></label>
      </div>
      <footer><button type="button" onClick={()=>setShowForm(false)}>إلغاء</button><button className="calendar-primary" disabled={saving}>{saving?'جارٍ الحفظ…':'حفظ المهمة'}</button></footer>
    </form></div>}

    {selected&&<div className="calendar-modal-layer"><button className="calendar-modal-backdrop" onClick={()=>setSelected(null)} aria-label="إغلاق"/><section className="calendar-task-details">
      <header><div><span className={'timing '+selected.timing_state}>{timingText(selected)}</span><h2>{selected.title}</h2></div><button onClick={()=>setSelected(null)}>×</button></header>
      <dl><div><dt>المسند إليه</dt><dd>{selected.assigned_name||'—'}</dd></div><div><dt>الموعد</dt><dd>{formatDate(selected.due_at)} · {formatTime(selected.due_at)}</dd></div><div><dt>الحالة</dt><dd>{selected.status==='completed'?'مكتملة':'مفتوحة'}</dd></div><div><dt>التكرار</dt><dd>{selected.recurrence_type==='none'?'غير متكررة':selected.recurrence_type==='daily'?'يومي':selected.recurrence_type==='weekly'?'أسبوعي':'شهري'}</dd></div></dl>
      {selected.description&&<p>{selected.description}</p>}{selected.lead&&<aside><b>{selected.lead.customer_name}</b><span>{selected.lead.phone}</span><small>{selected.lead.program_name||''}{selected.lead.ad_name?' · '+selected.lead.ad_name:''}</small></aside>}
      <footer><button onClick={()=>setSelected(null)}>إغلاق</button>{selected.status!=='completed'&&<button className="calendar-primary" onClick={()=>completeTask(selected)} disabled={saving}>إتمام المهمة</button>}</footer>
    </section></div>}
  </main>;
}
