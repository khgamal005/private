const fs = require('fs');
const path = require('path');

const pageDir = path.join('app','tenant','[slug]','calendar');
const componentDir = 'components';
const pagePath = path.join(pageDir,'page.js');
const componentPath = path.join(componentDir,'task-calendar-page.js');
const operationsRuntimePath = path.join(componentDir,'operations-runtime.js');
const themePath = fs.existsSync('app/marktone-theme.css') ? 'app/marktone-theme.css' : 'app/globals.css';

fs.mkdirSync(pageDir,{recursive:true});
fs.mkdirSync(componentDir,{recursive:true});

const pageSource = `import TaskCalendarPage from '../../../../components/task-calendar-page';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({params}){
  const {slug}=await params;
  return <TaskCalendarPage slug={slug}/>;
}
`;

const componentSource = String.raw`'use client';

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

export default function TaskCalendarPage({slug}){
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

  return <main className="role-calendar-page" dir="rtl">
    <header className="role-calendar-topbar">
      <div className="calendar-title-block">
        <a href={'/tenant/'+encodeURIComponent(slug)} className="calendar-back" aria-label="العودة إلى المنصة">→</a>
        <div><small>MARKTONE TASKS</small><h1>تقويم المهام</h1><p>{context?.roleLabel||'مستخدم'} · المهام المسندة والمواعيد المتكررة</p></div>
      </div>
      <div className="calendar-top-actions">
        <button type="button" className="calendar-refresh" onClick={loadCalendar} disabled={loading}>تحديث</button>
        <button type="button" className="calendar-primary" onClick={()=>setShowForm(true)}>+ مهمة جديدة</button>
      </div>
    </header>

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
`;

fs.writeFileSync(pagePath,pageSource,'utf8');
fs.writeFileSync(componentPath,componentSource,'utf8');

if(fs.existsSync(operationsRuntimePath)){
  let runtime=fs.readFileSync(operationsRuntimePath,'utf8');
  runtime=runtime.replace(
    /<NavButton target=\{nav\} onClick=\{\(\)=>show\('calendar'\)\}>/,
    "<NavButton target={nav} onClick={()=>{location.href='/tenant/'+encodeURIComponent(tenantSlug())+'/calendar'}}>",
  );
  fs.writeFileSync(operationsRuntimePath,runtime,'utf8');
}

const marker='/* MARKTONE ROLE CALENDAR RELEASE 1.5.1 */';
let css=fs.readFileSync(themePath,'utf8');
css=css.split(marker)[0].trimEnd();
const calendarCss=String.raw`

${marker}
.role-calendar-page{min-height:100dvh;background:var(--mt-background,#f4f7fb);color:var(--mt-foreground,#102f55);padding:22px 24px 48px;font-family:Tahoma,var(--font-geist-sans),Arial,sans-serif}.role-calendar-topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;max-width:1500px;margin:0 auto 18px}.calendar-title-block{display:flex;align-items:center;gap:14px}.calendar-back{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:#fff;border:1px solid #dce5f0;color:#102f55;font-size:22px;text-decoration:none;box-shadow:0 8px 24px rgba(16,47,85,.07)}.calendar-title-block small,.calendar-task-form header small{font-family:var(--font-geist-sans),Arial,sans-serif;letter-spacing:.12em;font-size:10px;font-weight:600;color:#b68b2d}.calendar-title-block h1{font-size:28px;line-height:1.2;margin:3px 0 4px;font-weight:700}.calendar-title-block p{margin:0;color:#718096;font-size:12px}.calendar-top-actions{display:flex;gap:9px}.calendar-top-actions button,.calendar-primary,.calendar-refresh{border:0;border-radius:11px;padding:11px 17px;font:600 12px Tahoma;cursor:pointer}.calendar-primary{background:#c9a34e;color:#102f55;box-shadow:0 8px 18px rgba(201,163,78,.2)}.calendar-refresh{background:#fff;color:#102f55;border:1px solid #dce5f0!important}.calendar-alert{max-width:1500px;margin:0 auto 14px;padding:12px 15px;border-radius:12px;font-size:12px}.calendar-alert.error{background:#fff0f0;color:#a23030;border:1px solid #f0c4c4}.calendar-alert.success{background:#eefaf4;color:#18704b;border:1px solid #bfe6d2}.calendar-summary-grid{max-width:1500px;margin:0 auto 16px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.calendar-summary-grid button{appearance:none;text-align:right;background:#fff;border:1px solid #dde6f0;border-radius:16px;padding:15px 16px;cursor:pointer;color:#102f55;box-shadow:0 8px 25px rgba(16,47,85,.05);transition:.18s}.calendar-summary-grid button:hover,.calendar-summary-grid button.active{transform:translateY(-2px);border-color:#c9a34e;box-shadow:0 12px 30px rgba(16,47,85,.09)}.calendar-summary-grid span{display:block;font-size:11px;font-weight:500;color:#61728a}.calendar-summary-grid b{display:block;font-family:var(--font-geist-sans),Tahoma;font-size:27px;font-weight:700;margin:4px 0;color:#102f55}.calendar-summary-grid small{display:block;font-size:10px;color:#8a98aa}.calendar-summary-grid .danger b{color:#c53f4d}.calendar-summary-grid .warning b{color:#b47b12}.calendar-controlbar{max-width:1500px;margin:0 auto 10px;background:#fff;border:1px solid #dde6f0;border-radius:16px;padding:12px 14px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:14px}.calendar-controlbar h2{font-size:17px;font-weight:600;margin:0;text-align:center}.calendar-month-switch,.calendar-view-controls,.calendar-mode-toggle{display:flex;align-items:center;gap:7px}.calendar-view-controls{justify-content:flex-end}.calendar-month-switch button,.calendar-mode-toggle button,.calendar-filterbar button{border:1px solid #dce5f0;background:#f8fafc;color:#102f55;border-radius:9px;padding:8px 11px;font:500 11px Tahoma;cursor:pointer}.calendar-month-switch button:first-child,.calendar-month-switch button:last-child{font-size:18px;padding-block:4px}.calendar-view-controls select{border:1px solid #dce5f0;background:#fff;border-radius:9px;padding:8px 10px;font:500 11px Tahoma;color:#102f55}.calendar-mode-toggle{padding:3px;background:#eef3f8;border-radius:11px}.calendar-mode-toggle button{border:0;background:transparent}.calendar-mode-toggle button.active,.calendar-filterbar button.active{background:#102f55;color:#fff}.calendar-filterbar{max-width:1500px;margin:0 auto 11px;display:flex;gap:7px;overflow:auto}.role-calendar-weekdays{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));background:#102f55;color:#fff;border-radius:14px 14px 0 0;overflow:hidden}.role-calendar-weekdays span{text-align:center;padding:10px;font-size:10px;font-weight:500;border-inline-start:1px solid rgba(255,255,255,.08)}.role-calendar-grid{max-width:1500px;margin:0 auto;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));background:#dfe7f0;gap:1px;border:1px solid #dfe7f0;border-radius:0 0 15px 15px;overflow:hidden}.role-calendar-grid>article{min-height:135px;background:#fff;padding:8px;min-width:0}.role-calendar-grid>article.outside{background:#f7f9fc;color:#9ba7b6}.role-calendar-grid>article.today{box-shadow:inset 0 0 0 2px #c9a34e}.role-calendar-grid>article>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}.role-calendar-grid>article>header b{font-family:var(--font-geist-sans),Tahoma;font-size:12px}.role-calendar-grid>article>header span{display:grid;place-items:center;min-width:20px;height:20px;border-radius:999px;background:#e9f0f7;font:600 9px var(--font-geist-sans),Tahoma}.role-calendar-grid>article>div{display:grid;gap:5px}.role-calendar-task{position:relative;text-align:right;border:0;border-inline-start:3px solid #6b87a9;background:#eef4fa;color:#102f55;border-radius:7px;padding:6px 7px;cursor:pointer;min-width:0}.role-calendar-task strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9.5px;font-weight:600}.role-calendar-task small{font-family:var(--font-geist-sans),Tahoma;font-size:8.5px;color:#6f7f92}.role-calendar-task em{position:absolute;left:5px;bottom:5px;font-style:normal}.role-calendar-task.overdue{border-color:#ce4654;background:#fff1f2}.role-calendar-task.today{border-color:#d7971e;background:#fff7e7}.role-calendar-task.completed_on_time{border-color:#2f9c72;background:#edf9f4}.role-calendar-task.late{border-color:#8d5bc2;background:#f7f0ff}.more-tasks{border:0;background:transparent;color:#60728a;font:500 9px Tahoma;cursor:pointer;text-align:right}.role-calendar-agenda{max-width:1500px;margin:0 auto;display:grid;gap:8px}.role-calendar-agenda article{display:grid;grid-template-columns:145px minmax(0,1fr) auto auto;gap:14px;align-items:center;background:#fff;border:1px solid #dfe7f0;border-radius:14px;padding:12px 14px;cursor:pointer}.role-calendar-agenda article.overdue{border-inline-start:4px solid #ce4654}.role-calendar-agenda article.today{border-inline-start:4px solid #d7971e}.role-calendar-agenda time{display:grid;gap:3px;color:#64748b;font-size:10px}.role-calendar-agenda time b{font-family:var(--font-geist-sans),Tahoma;font-size:12px;color:#102f55}.agenda-main{min-width:0}.agenda-main strong{display:block;font-size:12px;font-weight:600}.agenda-main p{margin:3px 0;color:#697b90;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agenda-main small{font-size:9px;color:#8a98aa}.agenda-badges{display:flex;gap:5px;flex-wrap:wrap}.timing,.recurring{display:inline-flex;align-items:center;border-radius:999px;padding:5px 8px;font-size:9px;font-weight:500;background:#edf3f8;color:#51657d}.timing.overdue{background:#fff0f1;color:#bb3544}.timing.today{background:#fff5df;color:#a96d08}.timing.late{background:#f4eaff;color:#7543a8}.timing.completed_on_time{background:#e9f8f1;color:#247b59}.recurring{background:#eaf2ff;color:#315f9d}.complete-inline{border:0;border-radius:9px;background:#102f55;color:#fff;padding:8px 12px;font:500 10px Tahoma;cursor:pointer}.calendar-loading,.calendar-empty{max-width:1500px;margin:0 auto;background:#fff;border:1px dashed #ccd8e5;border-radius:15px;padding:48px;text-align:center;color:#718096;font-size:12px}.calendar-modal-layer{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:18px}.calendar-modal-backdrop{position:absolute;inset:0;border:0;background:rgba(7,25,48,.55);backdrop-filter:blur(7px)}.calendar-task-form,.calendar-task-details{position:relative;z-index:1;width:min(720px,100%);max-height:calc(100dvh - 36px);overflow:auto;background:#fff;border-radius:20px;box-shadow:0 30px 80px rgba(5,24,46,.25)}.calendar-task-form>header,.calendar-task-details>header{display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px;border-bottom:1px solid #e3eaf2}.calendar-task-form header h2,.calendar-task-details header h2{font-size:18px;font-weight:600;margin:4px 0 0}.calendar-task-form header>button,.calendar-task-details header>button{border:0;background:#edf2f7;width:34px;height:34px;border-radius:10px;font-size:20px;cursor:pointer}.calendar-form-grid{padding:18px 20px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.calendar-form-grid label{display:grid;gap:6px;font-size:10px;font-weight:500;color:#53667e}.calendar-form-grid .wide{grid-column:1/-1}.calendar-form-grid input,.calendar-form-grid select,.calendar-form-grid textarea{width:100%;border:1px solid #d9e3ee;border-radius:10px;padding:10px 11px;background:#fff;color:#102f55;font:400 11px Tahoma;outline:0}.calendar-form-grid input:focus,.calendar-form-grid select:focus,.calendar-form-grid textarea:focus{border-color:#c9a34e;box-shadow:0 0 0 3px rgba(201,163,78,.12)}.calendar-task-form>footer,.calendar-task-details>footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid #e3eaf2}.calendar-task-form>footer button,.calendar-task-details>footer button{border:1px solid #dce5ef;background:#fff;border-radius:10px;padding:10px 15px;font:500 11px Tahoma;cursor:pointer}.calendar-task-details{width:min(560px,100%)}.calendar-task-details dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:18px 20px;margin:0}.calendar-task-details dl div{background:#f5f8fb;border-radius:11px;padding:10px}.calendar-task-details dt{font-size:9px;color:#72839a}.calendar-task-details dd{margin:4px 0 0;font-size:11px;font-weight:500}.calendar-task-details>p,.calendar-task-details>aside{margin:0 20px 16px;padding:13px;border-radius:11px;background:#f5f8fb;font-size:11px;line-height:1.8}.calendar-task-details>aside{display:grid}.calendar-task-details>aside span{font-family:var(--font-geist-sans),Tahoma;margin:4px 0}.calendar-task-details>aside small{color:#718096}.calendar-task-details footer .calendar-primary{background:#c9a34e;border-color:#c9a34e}.role-calendar-page button:disabled{opacity:.55;cursor:wait}
@media(max-width:900px){.role-calendar-page{padding:14px 12px 36px}.role-calendar-topbar{align-items:flex-start}.calendar-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.calendar-controlbar{grid-template-columns:1fr;justify-items:stretch}.calendar-controlbar h2{grid-row:1}.calendar-month-switch{justify-content:center}.calendar-view-controls{justify-content:space-between}.role-calendar-weekdays{display:none}.role-calendar-grid{grid-template-columns:1fr;border-radius:14px;background:transparent;border:0;gap:8px}.role-calendar-grid>article{min-height:auto;border:1px solid #dfe7f0;border-radius:13px;display:grid;grid-template-columns:42px 1fr;gap:8px}.role-calendar-grid>article.outside{display:none}.role-calendar-grid>article>header{margin:0;display:grid;place-items:center;align-content:center;border-inline-end:1px solid #e5ebf2}.role-calendar-grid>article>div{grid-template-columns:1fr}.role-calendar-agenda article{grid-template-columns:95px minmax(0,1fr);gap:9px}.agenda-badges{grid-column:2}.complete-inline{grid-column:2;justify-self:start}.calendar-modal-layer{align-items:end;padding:0}.calendar-task-form,.calendar-task-details{width:100%;max-height:92dvh;border-radius:20px 20px 0 0}.calendar-form-grid{grid-template-columns:1fr}.calendar-form-grid .wide{grid-column:auto}}
@media(max-width:560px){.role-calendar-topbar{display:grid}.calendar-top-actions{width:100%}.calendar-top-actions button{flex:1}.calendar-title-block h1{font-size:22px}.calendar-summary-grid{gap:8px}.calendar-summary-grid button{padding:12px}.calendar-summary-grid b{font-size:23px}.calendar-view-controls{display:grid;grid-template-columns:1fr auto}.calendar-view-controls select{width:100%}.role-calendar-agenda article{grid-template-columns:1fr}.role-calendar-agenda time{display:flex;justify-content:space-between}.agenda-badges,.complete-inline{grid-column:auto}.calendar-task-details dl{grid-template-columns:1fr}}
`;
fs.writeFileSync(themePath,`${css}${calendarCss}\n`,'utf8');

const releasePath='public/release.json';
const release=JSON.parse(fs.readFileSync(releasePath,'utf8'));
release.version='1.5.1';
release.release='completed-role-task-calendar';
release.taskCalendar=true;
release.taskCalendarPage=true;
release.taskRecurrence=true;
release.roleAwareCalendar=true;
release.crmTaskMirror=true;
fs.writeFileSync(releasePath,JSON.stringify(release,null,2)+'\n');

console.log('Applied completed role task calendar release 1.5.1');
