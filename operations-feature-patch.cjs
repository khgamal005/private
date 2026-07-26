const fs = require('fs');
const path = require('path');

const routeDir = path.join('app','api','operations','[action]');
const componentDir = 'components';
const routePath = path.join(routeDir,'route.js');
const componentPath = path.join(componentDir,'operations-runtime.js');
const themePath = fs.existsSync('app/marktone-theme.css') ? 'app/marktone-theme.css' : 'app/globals.css';
const layoutPath = 'app/layout.js';

fs.mkdirSync(routeDir,{recursive:true});
fs.mkdirSync(componentDir,{recursive:true});

const routeSource = String.raw`import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://gswpbwdactcstkasddta.supabase.co';
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_bbfZERLAC2GzJxauAG_-Ng_c2dtZWzE';

function json(body,status=200){return NextResponse.json(body,{status,headers:{'cache-control':'no-store'}})}
function publicFailure(error){
  const code=String(error?.code||'');const message=String(error?.message||'');
  const value=(code+' '+message).toLowerCase();
  if(/42501|forbidden|not_allowed|outside_tenant|cannot_assign|identity_not_provisioned/.test(value))return {status:403,message:'ليس لديك صلاحية لتنفيذ هذا الإجراء.'};
  if(/p0002|not_found/.test(value))return {status:404,message:'العنصر المطلوب غير موجود.'};
  if(/invalid|required|must_be|start_after|no_available|batch_not_ready/.test(value))return {status:400,message:'تعذر تنفيذ الطلب. راجع البيانات المدخلة وحاول مرة أخرى.'};
  return {status:Number(error?.status)>=400&&Number(error?.status)<500?Number(error.status):500,message:'تعذر تنفيذ الطلب الآن. حاول مرة أخرى لاحقًا.'};
}
function decodeBase64(value){try{return Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8')}catch{return ''}}
function tokenFromValue(input){
  if(!input)return null;
  let value=input;
  try{value=decodeURIComponent(value)}catch{}
  if(value.startsWith('base64-'))value=decodeBase64(value.slice(7));
  try{
    const parsed=JSON.parse(value);
    if(Array.isArray(parsed)&&typeof parsed[0]==='string')return parsed[0];
    if(parsed&&typeof parsed==='object')return parsed.access_token||parsed.accessToken||parsed.currentSession?.access_token||null;
  }catch{}
  const match=value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return match?match[0]:null;
}
function cookieTokenCandidates(request){
  const all=request.cookies.getAll();
  const candidates=[];
  const groups=new Map();
  for(const cookie of all){
    const base=cookie.name.replace(/\.\d+$/,'');
    if(!groups.has(base))groups.set(base,[]);
    groups.get(base).push(cookie);
    const direct=tokenFromValue(cookie.value);if(direct)candidates.push(direct);
  }
  for(const cookies of groups.values()){
    const joined=cookies.sort((a,b)=>Number(a.name.split('.').pop())-Number(b.name.split('.').pop())).map(x=>x.value).join('');
    const token=tokenFromValue(joined);if(token)candidates.push(token);
  }
  return [...new Set(candidates)];
}
async function verifyToken(token){
  const response=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:PUBLISHABLE_KEY,authorization:'Bearer '+token},cache:'no-store'});
  if(!response.ok)return null;
  return response.json();
}
async function resolveUser(request){
  for(const token of cookieTokenCandidates(request)){
    const user=await verifyToken(token);if(user?.id)return {user,token};
  }
  return null;
}
async function rpc(name,args,token){
  if(!token)throw new Error('AUTH_SESSION_REQUIRED');
  const response=await fetch(SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:PUBLISHABLE_KEY,authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(args),cache:'no-store'});
  const payload=await response.json().catch(()=>null);
  if(!response.ok){const error=new Error(payload?.message||payload?.error||('RPC '+name+' failed'));error.code=payload?.code||null;error.status=response.status;throw error}
  return payload;
}
function tenantSlug(request,body){return body?.tenantSlug||new URL(request.url).searchParams.get('tenantSlug')||null}
function userArgs(user,slug){return {p_user_id:user.id,p_email:user.email||null,p_name:user.user_metadata?.name||user.user_metadata?.full_name||null,p_tenant_slug:slug}}
function normalizeHeader(value){return String(value||'').trim().toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/\s+/g,' ')}
function pick(row,aliases){const entries=Object.entries(row);for(const alias of aliases){const found=entries.find(([key])=>normalizeHeader(key)===normalizeHeader(alias));if(found)return found[1]}return ''}
function normalizeRows(sheet){
  const source=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});
  return source.map(row=>({
    name:String(pick(row,['الاسم','اسم العميل','اسم المتدرب','name','customer name'])||'').trim(),
    phone:String(pick(row,['رقم الهاتف','رقم الجوال','الجوال','الهاتف','phone','mobile'])||'').trim(),
    program:String(pick(row,['البرنامج او الدوره','البرنامج أو الدورة','البرنامج','الدوره','الدورة','program','course'])||'').trim(),
    ad_name:String(pick(row,['اسم الاعلان','اسم الإعلان','الاعلان','الإعلان','ad name','campaign'])||'').trim(),
  })).filter(row=>row.name||row.phone||row.program||row.ad_name);
}

export async function GET(request,{params}){
  try{
    const {action}=await params;
    const session=await resolveUser(request);if(!session)return json({error:'غير مصرح. أعد تسجيل الدخول.'},401);
    const {user,token}=session;
    const url=new URL(request.url);const slug=url.searchParams.get('tenantSlug')||null;
    if(action==='bootstrap')return json(await rpc('operations_bootstrap',{...userArgs(user,slug)},token));
    if(action==='calendar')return json(await rpc('operations_calendar',{p_user_id:user.id,p_tenant_slug:slug,p_from:url.searchParams.get('from'),p_to:url.searchParams.get('to'),p_scope:url.searchParams.get('scope')||'mine'},token));
    if(action==='template'){
      const sheet=XLSX.utils.aoa_to_sheet([
        ['الاسم','رقم الهاتف','البرنامج أو الدورة','اسم الإعلان'],
        ['اسم العميل','05xxxxxxxx','اسم البرنامج أو الدورة','اسم الحملة أو الإعلان'],
      ]);
      sheet['!cols']=[{wch:28},{wch:18},{wch:30},{wch:28}];
      const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,'نموذج العملاء');
      const buffer=XLSX.write(workbook,{bookType:'xlsx',type:'buffer'});
      return new NextResponse(buffer,{status:200,headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':'attachment; filename="marktone-customers-template.xlsx"','cache-control':'no-store'}});
    }
    return json({error:'الإجراء غير موجود'},404);
  }catch(error){const failure=publicFailure(error);return json({error:failure.message},failure.status)}
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    const session=await resolveUser(request);if(!session)return json({error:'غير مصرح. أعد تسجيل الدخول.'},401);
    const {user,token}=session;
    if(action==='upload'){
      const form=await request.formData();const file=form.get('file');const slug=String(form.get('tenantSlug')||'')||null;
      if(!file||typeof file.arrayBuffer!=='function')return json({error:'اختر ملف Excel أو CSV'},400);
      if(file.size>10*1024*1024)return json({error:'الحد الأقصى لحجم الملف 10 ميجابايت'},413);
      const buffer=Buffer.from(await file.arrayBuffer());
      const workbook=XLSX.read(buffer,{type:'buffer',cellDates:true});
      const sheet=workbook.Sheets[workbook.SheetNames[0]];const rows=normalizeRows(sheet);
      if(!rows.length)return json({error:'لم يتم العثور على بيانات مطابقة للنموذج'},400);
      if(rows.length>10000)return json({error:'الحد الأقصى 10,000 عميل في الملف الواحد'},400);
      return json(await rpc('operations_import_batch',{p_user_id:user.id,p_tenant_slug:slug,p_file_name:file.name||'customers.xlsx',p_rows:rows},token));
    }
    const body=await request.json().catch(()=>({}));const slug=tenantSlug(request,body);
    if(action==='heartbeat')return json(await rpc('operations_heartbeat',{...userArgs(user,slug)},token));
    if(action==='team')return json(await rpc('operations_upsert_team',{p_user_id:user.id,p_tenant_slug:slug,p_team_id:body.teamId||null,p_name:body.name,p_manager_user_id:body.managerUserId||null,p_member_ids:body.memberIds||[]},token));
    if(action==='distribute')return json(await rpc('operations_distribute',{p_user_id:user.id,p_batch_id:body.batchId,p_team_id:body.teamId,p_method:body.method,p_due_at:body.dueAt},token));
    if(action==='task')return json(await rpc('operations_create_task',{p_user_id:user.id,p_tenant_slug:slug,p_title:body.title,p_description:body.description||null,p_assigned_to:body.assignedTo||null,p_starts_at:body.startsAt||null,p_due_at:body.dueAt,p_recurrence_type:body.recurrenceType||'none',p_recurrence_interval:Number(body.recurrenceInterval||1),p_recurrence_end_at:body.recurrenceEndAt||null},token));
    if(action==='complete')return json(await rpc('operations_complete_task',{p_user_id:user.id,p_task_id:body.taskId},token));
    return json({error:'الإجراء غير موجود'},404);
  }catch(error){const failure=publicFailure(error);return json({error:failure.message},failure.status)}
}
`;

const componentSource = String.raw`'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

const AR_DAYS=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
function isoLocal(date){const d=new Date(date);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)}
function tenantSlug(){const match=location.pathname.match(/^\/tenant\/([^/]+)/);return match?decodeURIComponent(match[1]):''}
async function requestApi(action,options={}){
  const slug=tenantSlug();const query=options.query||{};if(slug&&!query.tenantSlug)query.tenantSlug=slug;
  const qs=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==null&&v!==undefined&&v!=='')).toString();
  const response=await fetch('/api/operations/'+action+(qs?'?'+qs:''),{credentials:'include',headers:{...(options.body instanceof FormData?{}:{'content-type':'application/json'}),...(options.headers||{})},method:options.method||'GET',body:options.body instanceof FormData?options.body:options.body?JSON.stringify({...options.body,tenantSlug:slug||null}):undefined});
  const payload=await response.json().catch(()=>({error:'استجابة غير صالحة'}));if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ الطلب');return payload;
}
function startOfMonth(value){return new Date(value.getFullYear(),value.getMonth(),1)}
function endOfMonth(value){return new Date(value.getFullYear(),value.getMonth()+1,0,23,59,59)}
function calendarDays(value){const start=startOfMonth(value);const first=new Date(start);first.setDate(first.getDate()-first.getDay());return Array.from({length:42},(_,i)=>{const d=new Date(first);d.setDate(first.getDate()+i);return d})}
function sameDay(a,b){return new Date(a).toDateString()===new Date(b).toDateString()}
function timingLabel(task){return task.timing_state==='overdue'?'متأخرة':task.timing_state==='today'?'اليوم':task.timing_state==='late'?'اكتملت متأخرًا':task.status==='completed'?'اكتملت في الموعد':'قادمة'}
function NavButton({target,children,onClick}){return target?createPortal(<button type="button" className="operations-nav-button" onClick={onClick}>{children}</button>,target):null}

export default function OperationsRuntime(){
  const [nav,setNav]=useState(null);const [context,setContext]=useState(null);const [open,setOpen]=useState(false);const [view,setView]=useState('calendar');const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  const [month,setMonth]=useState(()=>new Date());const [scope,setScope]=useState('mine');const [tasks,setTasks]=useState([]);const [showTaskForm,setShowTaskForm]=useState(false);
  const [taskForm,setTaskForm]=useState({title:'',description:'',assignedTo:'',startsAt:isoLocal(new Date()),dueAt:isoLocal(new Date(Date.now()+86400000)),recurrenceType:'none',recurrenceInterval:1,recurrenceEndAt:''});
  const [uploadResult,setUploadResult]=useState(null);const [teamForm,setTeamForm]=useState({name:'',memberIds:[]});const [distribution,setDistribution]=useState({batchId:'',teamId:'',method:'fair',dueAt:isoLocal(new Date(Date.now()+86400000))});
  const permissions=context?.permissions||{};const user=context?.user||{};const members=context?.members||[];const teams=context?.teams||[];const batches=context?.batches||[];

  async function bootstrap(){try{setError('');const data=await requestApi('bootstrap');setContext(data)}catch(e){setError(e.message)}}
  async function loadCalendar(){try{setBusy(true);setError('');const data=await requestApi('calendar',{query:{from:startOfMonth(month).toISOString(),to:endOfMonth(month).toISOString(),scope}});setTasks(Array.isArray(data)?data:[])}catch(e){setError(e.message)}finally{setBusy(false)}}
  useEffect(()=>{let timer;const find=()=>{const target=document.querySelector('.side nav');if(target){setNav(target);bootstrap();requestApi('heartbeat',{method:'POST',body:{}}).catch(()=>{});timer=setInterval(()=>requestApi('heartbeat',{method:'POST',body:{}}).catch(()=>{}),60000)}else setTimeout(find,250)};find();return()=>clearInterval(timer)},[]);
  useEffect(()=>{if(open&&view==='calendar')loadCalendar()},[open,view,month,scope]);
  function show(next){setView(next);setOpen(true);setNotice('');setError('')}
  async function createTask(event){event.preventDefault();try{setBusy(true);await requestApi('task',{method:'POST',body:{...taskForm,assignedTo:taskForm.assignedTo||null,recurrenceEndAt:taskForm.recurrenceEndAt||null}});setNotice('تم إنشاء المهمة بنجاح');setShowTaskForm(false);setTaskForm({...taskForm,title:'',description:''});await loadCalendar()}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function completeTask(taskId){try{setBusy(true);await requestApi('complete',{method:'POST',body:{taskId}});await loadCalendar()}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function upload(event){event.preventDefault();const file=event.currentTarget.elements.file.files[0];if(!file)return;try{setBusy(true);const form=new FormData();form.append('file',file);form.append('tenantSlug',tenantSlug());const data=await requestApi('upload',{method:'POST',body:form});setUploadResult(data);setNotice('تم رفع الملف والتحقق من البيانات');await bootstrap()}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function saveTeam(event){event.preventDefault();try{setBusy(true);await requestApi('team',{method:'POST',body:{name:teamForm.name,memberIds:teamForm.memberIds}});setNotice('تم حفظ فريق المبيعات');setTeamForm({name:'',memberIds:[]});await bootstrap()}catch(e){setError(e.message)}finally{setBusy(false)}}
  async function distribute(event){event.preventDefault();try{setBusy(true);const data=await requestApi('distribute',{method:'POST',body:distribution});setNotice('تم توزيع '+data.assigned_count+' عميل وإنشاء المهام');await bootstrap()}catch(e){setError(e.message)}finally{setBusy(false)}}
  const days=useMemo(()=>calendarDays(month),[month]);
  const grouped=useMemo(()=>days.map(day=>({day,tasks:tasks.filter(task=>sameDay(task.due_at,day))})),[days,tasks]);
  const agenda=useMemo(()=>[...tasks].sort((a,b)=>new Date(a.due_at)-new Date(b.due_at)),[tasks]);

  return <>
    <NavButton target={nav} onClick={()=>show('calendar')}><span aria-hidden="true">▦</span><span>تقويم المهام</span></NavButton>
    {permissions.import&&<NavButton target={nav} onClick={()=>show('import')}><span aria-hidden="true">⇧</span><span>استيراد العملاء</span></NavButton>}
    {permissions.distribute&&<NavButton target={nav} onClick={()=>show('distribution')}><span aria-hidden="true">⇄</span><span>توزيع العملاء</span></NavButton>}
    {open&&createPortal(<div className="operations-overlay" role="dialog" aria-modal="true">
      <button className="operations-backdrop" aria-label="إغلاق" onClick={()=>setOpen(false)}/>
      <section className="operations-workspace">
        <header className="operations-header"><div><small>MARKTONE OPERATIONS</small><h2>{view==='calendar'?'تقويم المهام':view==='import'?'استيراد بيانات العملاء':'إدارة وتوزيع العملاء'}</h2></div><button type="button" className="operations-close" onClick={()=>setOpen(false)}>×</button></header>
        <nav className="operations-tabs"><button className={view==='calendar'?'active':''} onClick={()=>setView('calendar')}>التقويم</button>{permissions.import&&<button className={view==='import'?'active':''} onClick={()=>setView('import')}>الاستيراد</button>}{permissions.distribute&&<button className={view==='distribution'?'active':''} onClick={()=>setView('distribution')}>التوزيع والفرق</button>}</nav>
        {error&&<div className="operations-message error">{error}</div>}{notice&&<div className="operations-message success">{notice}</div>}
        <div className="operations-body">
          {view==='calendar'&&<>
            <div className="calendar-toolbar"><div><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}>‹</button><button onClick={()=>setMonth(new Date())}>اليوم</button><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}>›</button></div><strong>{MONTHS[month.getMonth()]} {month.getFullYear()}</strong><div><select value={scope} onChange={e=>setScope(e.target.value)}><option value="mine">مهامي</option>{permissions.viewTeam&&<option value="team">مهام فريقي</option>}{user.role_code==='admin'&&<option value="all">كل المهام</option>}</select><button className="primary" onClick={()=>setShowTaskForm(!showTaskForm)}>+ مهمة جديدة</button></div></div>
            {showTaskForm&&<form className="operations-form task-create" onSubmit={createTask}><label>عنوان المهمة<input required value={taskForm.title} onChange={e=>setTaskForm({...taskForm,title:e.target.value})}/></label><label>المسند إليه<select value={taskForm.assignedTo} onChange={e=>setTaskForm({...taskForm,assignedTo:e.target.value})}><option value="">أنا</option>{permissions.viewTeam&&members.map(member=><option key={member.user_id} value={member.user_id}>{member.display_name||member.email}</option>)}</select></label><label>تبدأ في<input type="datetime-local" value={taskForm.startsAt} onChange={e=>setTaskForm({...taskForm,startsAt:e.target.value})}/></label><label>تنتهي في<input required type="datetime-local" value={taskForm.dueAt} onChange={e=>setTaskForm({...taskForm,dueAt:e.target.value})}/></label><label>التكرار<select value={taskForm.recurrenceType} onChange={e=>setTaskForm({...taskForm,recurrenceType:e.target.value})}><option value="none">بدون تكرار</option><option value="daily">يومي</option><option value="weekly">أسبوعي</option><option value="monthly">شهري</option></select></label>{taskForm.recurrenceType!=='none'&&<><label>كل<input type="number" min="1" max="52" value={taskForm.recurrenceInterval} onChange={e=>setTaskForm({...taskForm,recurrenceInterval:e.target.value})}/></label><label>نهاية التكرار<input required type="datetime-local" value={taskForm.recurrenceEndAt} onChange={e=>setTaskForm({...taskForm,recurrenceEndAt:e.target.value})}/></label></>}<label className="wide">التفاصيل<textarea value={taskForm.description} onChange={e=>setTaskForm({...taskForm,description:e.target.value})}/></label><footer><button type="button" onClick={()=>setShowTaskForm(false)}>إلغاء</button><button className="primary" disabled={busy}>حفظ المهمة</button></footer></form>}
            <div className="calendar-weekdays">{AR_DAYS.map(day=><span key={day}>{day}</span>)}</div>
            <div className="calendar-grid">{grouped.map(({day,tasks:dayTasks})=><article key={day.toISOString()} className={(day.getMonth()!==month.getMonth()?'muted ':'')+(sameDay(day,new Date())?'today':'')}><header><b>{day.getDate()}</b><span>{dayTasks.length||''}</span></header>{dayTasks.slice(0,4).map(task=><button key={task.id} className={'calendar-task '+task.timing_state} onClick={()=>task.status!=='completed'&&completeTask(task.id)} title={task.title}><strong>{task.title}</strong><small>{new Date(task.due_at).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})} · {timingLabel(task)}</small></button>)}{dayTasks.length>4&&<em>+{dayTasks.length-4} مهام</em>}</article>)}</div>
            <div className="calendar-agenda">{agenda.length?agenda.map(task=><article key={task.id} className={task.timing_state}><time>{new Date(task.due_at).toLocaleDateString('ar-SA',{weekday:'short',day:'numeric',month:'short'})}<b>{new Date(task.due_at).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})}</b></time><div><strong>{task.title}</strong><span>{task.assigned_name||''}{task.lead?.customer_name?' · '+task.lead.customer_name:''}</span></div><em>{timingLabel(task)}</em>{task.status!=='completed'&&<button onClick={()=>completeTask(task.id)}>إتمام</button>}</article>):<p className="empty-state">لا توجد مهام في هذه الفترة.</p>}</div>
          </>}
          {view==='import'&&permissions.import&&<div className="import-layout"><section className="operations-card intro-card"><span>01</span><h3>حمّل النموذج الموحد</h3><p>النموذج يحتوي على: الاسم، رقم الهاتف، البرنامج أو الدورة، واسم الإعلان.</p><a className="primary button-link" href={'/api/operations/template?tenantSlug='+encodeURIComponent(tenantSlug())}>تحميل نموذج Excel</a></section><section className="operations-card"><span>02</span><h3>ارفع بيانات العملاء</h3><form className="upload-form" onSubmit={upload}><label className="file-drop"><input name="file" type="file" accept=".xlsx,.xls,.csv" required/><b>اختر ملف Excel أو اسحبه هنا</b><small>حتى 10,000 صف في الملف الواحد</small></label><button className="primary" disabled={busy}>رفع وفحص البيانات</button></form>{uploadResult&&<div className="import-summary"><div><b>{uploadResult.total_rows}</b><span>إجمالي الصفوف</span></div><div><b>{uploadResult.valid_rows}</b><span>صالحة</span></div><div><b>{uploadResult.duplicate_rows}</b><span>مكررة</span></div><div><b>{uploadResult.invalid_rows}</b><span>غير مكتملة</span></div></div>}</section></div>}
          {view==='distribution'&&permissions.distribute&&<div className="distribution-layout"><section className="operations-card"><h3>فريق المبيعات</h3><p>أنشئ فريقًا وحدد أعضاؤه. مسؤول المبيعات الحالي يصبح مدير الفريق والمسؤول عن المهام المسندة.</p><form className="operations-form" onSubmit={saveTeam}><label className="wide">اسم الفريق<input required value={teamForm.name} onChange={e=>setTeamForm({...teamForm,name:e.target.value})} placeholder="مثال: فريق مبيعات البرامج المهنية"/></label><fieldset className="wide member-picker"><legend>أعضاء الفريق</legend>{members.filter(member=>['sales_agent','member','sales_manager'].includes(member.role_code)).map(member=><label key={member.user_id}><input type="checkbox" checked={teamForm.memberIds.includes(member.user_id)} onChange={e=>setTeamForm({...teamForm,memberIds:e.target.checked?[...teamForm.memberIds,member.user_id]:teamForm.memberIds.filter(id=>id!==member.user_id)})}/><span><b>{member.display_name||member.email}</b><small className={member.is_online?'online':''}>{member.is_online?'متصل الآن':'غير متصل'}</small></span></label>)}</fieldset><button className="primary" disabled={busy}>حفظ الفريق</button></form></section><section className="operations-card"><h3>توزيع دفعة العملاء</h3><form className="operations-form" onSubmit={distribute}><label>دفعة العملاء<select required value={distribution.batchId} onChange={e=>setDistribution({...distribution,batchId:e.target.value})}><option value="">اختر الدفعة</option>{batches.filter(batch=>['ready','partially_distributed'].includes(batch.status)).map(batch=><option key={batch.id} value={batch.id}>{batch.file_name} — {batch.valid_rows-batch.assigned_rows} غير موزع</option>)}</select></label><label>الفريق<select required value={distribution.teamId} onChange={e=>setDistribution({...distribution,teamId:e.target.value})}><option value="">اختر الفريق</option>{teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>طريقة التوزيع<select value={distribution.method} onChange={e=>setDistribution({...distribution,method:e.target.value})}><option value="fair">توزيع عادل بالتساوي</option><option value="online_only">المتصلون على النظام فقط</option></select></label><label>آخر موعد للمهام<input required type="datetime-local" value={distribution.dueAt} onChange={e=>setDistribution({...distribution,dueAt:e.target.value})}/></label><div className="distribution-note wide"><b>{distribution.method==='fair'?'التوزيع العادل':'التوزيع على المتصلين'}</b><p>{distribution.method==='fair'?'يبدأ النظام بالموظف الأقل حصولًا على عملاء، ثم يوزع بالتتابع على الفريق.':'لا يتم الإسناد إلا لمن ظهر نشاطه داخل النظام خلال آخر 5 دقائق.'}</p></div><button className="primary wide" disabled={busy}>توزيع العملاء وإنشاء المهام</button></form></section></div>}
        </div>
      </section>
    </div>,document.body)}
  </>;
}
`;

fs.writeFileSync(routePath,routeSource,'utf8');
fs.writeFileSync(componentPath,componentSource,'utf8');

let layout=fs.readFileSync(layoutPath,'utf8');
if(!layout.includes("operations-runtime"))layout="import OperationsRuntime from '../components/operations-runtime';\n"+layout;
if(!layout.includes('<OperationsRuntime />')){
  if(layout.includes('</body>'))layout=layout.replace('</body>','<OperationsRuntime /></body>');
  else throw new Error('Could not inject OperationsRuntime into app/layout.js');
}
fs.writeFileSync(layoutPath,layout,'utf8');

const marker='/* MARKTONE OPERATIONS RELEASE 1.5.0 */';
let css=fs.readFileSync(themePath,'utf8');css=css.split(marker)[0].trimEnd();
const featureCss=String.raw`

${marker}
.operations-nav-button span:first-child{font-size:17px;line-height:1}.operations-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:22px;direction:rtl}.operations-backdrop{position:absolute;inset:0;border:0;background:rgba(6,22,45,.68);backdrop-filter:blur(9px)}.operations-workspace{position:relative;width:min(1400px,96vw);height:min(900px,94dvh);display:grid;grid-template-rows:auto auto auto minmax(0,1fr);background:#f4f8fd;border:1px solid rgba(255,255,255,.35);border-radius:26px;overflow:hidden;box-shadow:0 30px 90px rgba(4,20,43,.35)}.operations-header{display:flex;justify-content:space-between;align-items:center;padding:20px 24px;background:linear-gradient(135deg,#0b294c,#123c68);color:#fff}.operations-header small{font-family:var(--font-geist-sans),Arial,sans-serif;letter-spacing:2.4px;color:#f2c75c;font-size:9px;font-weight:600}.operations-header h2{margin:4px 0 0;font-size:22px;font-weight:700}.operations-close{width:42px;height:42px;border:1px solid rgba(255,255,255,.16);border-radius:13px;background:rgba(255,255,255,.08);color:#fff;font-size:28px;cursor:pointer}.operations-tabs{display:flex;gap:5px;padding:10px 18px;background:#fff;border-bottom:1px solid #dce6f2;overflow:auto}.operations-tabs button{min-height:38px;padding:8px 15px;border:0;border-radius:10px;background:transparent;color:#60718a;font-weight:500;white-space:nowrap}.operations-tabs button.active{background:#eef5ff;color:#0e4d8f;font-weight:600;box-shadow:inset 0 -2px 0 #f0bf45}.operations-message{margin:10px 20px 0;padding:10px 14px;border-radius:11px;font-size:12px}.operations-message.error{background:#fff1f1;color:#a52b2b;border:1px solid #ffd2d2}.operations-message.success{background:#edfff5;color:#147346;border:1px solid #c6f2d9}.operations-body{min-height:0;overflow:auto;padding:18px 20px 24px}.calendar-toolbar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;margin-bottom:14px}.calendar-toolbar>div{display:flex;gap:7px;align-items:center}.calendar-toolbar>div:last-child{justify-content:flex-end}.calendar-toolbar button,.calendar-toolbar select,.operations-form button,.operations-form input,.operations-form select,.operations-form textarea,.upload-form button{min-height:40px;border:1px solid #d5e1ef;border-radius:10px;background:#fff;color:#163452;padding:9px 12px;font:inherit}.calendar-toolbar button,.operations-form button,.upload-form button{cursor:pointer}.primary,.button-link.primary{background:#0c4e8f!important;color:#fff!important;border-color:#0c4e8f!important;font-weight:600!important}.calendar-toolbar strong{font-size:18px;font-weight:700;color:#102f52}.calendar-weekdays,.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:7px}.calendar-weekdays{margin-bottom:7px}.calendar-weekdays span{text-align:center;color:#77869b;font-size:11px;font-weight:500}.calendar-grid>article{min-height:126px;padding:9px;border:1px solid #dce6f1;border-radius:13px;background:#fff;overflow:hidden}.calendar-grid>article.muted{opacity:.48}.calendar-grid>article.today{border-color:#e5b62f;box-shadow:inset 0 0 0 1px #f6d878}.calendar-grid article>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.calendar-grid article>header b{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;font-size:12px}.calendar-grid article.today>header b{background:#123c68;color:#fff}.calendar-task{width:100%;display:block;margin:4px 0;padding:6px 7px;text-align:right;border:0;border-radius:8px;background:#edf5ff;color:#184976;cursor:pointer}.calendar-task strong,.calendar-task small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.calendar-task strong{font-size:10px;font-weight:600}.calendar-task small{font-size:8px;margin-top:2px}.calendar-task.overdue{background:#fff0f0;color:#a73535}.calendar-task.today{background:#fff7df;color:#8b6200}.calendar-task.on_time,.calendar-task.completed{background:#eafaf1;color:#1d7149}.calendar-agenda{display:none}.operations-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.operations-form label{display:grid;gap:6px;color:#52667f;font-size:11px;font-weight:500}.operations-form .wide,.operations-form footer{grid-column:1/-1}.operations-form textarea{min-height:82px;resize:vertical}.operations-form footer{display:flex;justify-content:flex-end;gap:8px}.task-create{margin:0 0 16px;padding:16px;background:#fff;border:1px solid #dce6f1;border-radius:16px}.operations-card{padding:20px;background:#fff;border:1px solid #dce6f1;border-radius:18px;box-shadow:0 10px 28px rgba(17,49,82,.05)}.operations-card>span{display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:#edf5ff;color:#0c4e8f;font-family:var(--font-geist-sans),Arial,sans-serif;font-weight:700}.operations-card h3{margin:10px 0 6px;font-size:16px;font-weight:600;color:#102f52}.operations-card p{color:#708097;font-size:11px;line-height:1.8}.import-layout,.distribution-layout{display:grid;grid-template-columns:minmax(0,.7fr) minmax(0,1.3fr);gap:16px}.button-link{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 15px;border-radius:11px;text-decoration:none;margin-top:12px}.upload-form{display:grid;gap:12px}.file-drop{min-height:170px;display:grid;place-items:center;align-content:center;gap:7px;border:1.5px dashed #9bb5d0;border-radius:15px;background:#f7fbff;text-align:center;cursor:pointer}.file-drop input{max-width:90%}.file-drop b{font-size:13px;color:#234866}.file-drop small{color:#7b8ba0}.import-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}.import-summary div{padding:12px;border-radius:12px;background:#f3f7fc;text-align:center}.import-summary b,.import-summary span{display:block}.import-summary b{font-family:var(--font-geist-sans),Arial,sans-serif;font-size:22px;color:#123c68}.import-summary span{font-size:9px;color:#77869a}.member-picker{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;border:0;padding:0}.member-picker legend{margin-bottom:7px}.member-picker>label{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid #dce6f1;border-radius:11px;background:#f9fbfe}.member-picker>label span{display:grid}.member-picker small{color:#8290a2}.member-picker small.online{color:#15945a}.member-picker small.online:before{content:'●';margin-left:5px}.distribution-note{padding:12px 14px;border-radius:12px;background:#eef6ff;border:1px solid #d5e8fb}.distribution-note p{margin:4px 0 0}.empty-state{padding:40px;text-align:center;color:#8190a3}
@media(max-width:820px){.operations-overlay{padding:0;align-items:end}.operations-workspace{width:100%;height:94dvh;border-radius:22px 22px 0 0}.operations-header{padding:16px}.operations-header h2{font-size:18px}.operations-body{padding:13px}.calendar-toolbar{grid-template-columns:1fr auto;gap:8px}.calendar-toolbar>strong{grid-column:1/-1;grid-row:1;text-align:center}.calendar-toolbar>div:first-child{grid-row:2}.calendar-toolbar>div:last-child{grid-row:2}.calendar-toolbar .primary{font-size:0;width:42px;padding:0}.calendar-toolbar .primary:after{content:'+';font-size:22px}.calendar-weekdays,.calendar-grid{display:none}.calendar-agenda{display:grid;gap:8px}.calendar-agenda article{display:grid;grid-template-columns:75px minmax(0,1fr) auto;gap:9px;align-items:center;padding:11px;background:#fff;border:1px solid #dce6f1;border-radius:13px}.calendar-agenda time,.calendar-agenda time b{display:block;font-size:9px;color:#6f8095}.calendar-agenda time b{font-size:11px;color:#163b61;margin-top:3px}.calendar-agenda article>div{display:grid;min-width:0}.calendar-agenda strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.calendar-agenda span{font-size:9px;color:#8090a4}.calendar-agenda em{font-size:9px;font-style:normal;padding:5px 7px;border-radius:8px;background:#edf5ff}.calendar-agenda article.overdue em{background:#fff0f0;color:#a73535}.calendar-agenda button{grid-column:2/-1;justify-self:start;border:0;background:#0c4e8f;color:#fff;border-radius:8px;padding:6px 10px}.operations-form{grid-template-columns:1fr}.operations-form .wide,.operations-form footer{grid-column:auto}.operations-form footer{display:grid;grid-template-columns:1fr 1fr}.import-layout,.distribution-layout{grid-template-columns:1fr}.import-summary{grid-template-columns:repeat(2,1fr)}.member-picker{grid-template-columns:1fr!important}.operations-tabs{padding-inline:12px}.operations-tabs button{flex:1}.operations-nav-button span:first-child{font-size:15px}}
`;
fs.writeFileSync(themePath,css+featureCss+'\n','utf8');

const releasePath='public/release.json';const release=JSON.parse(fs.readFileSync(releasePath,'utf8'));release.version='1.5.0';release.release='role-task-calendar-lead-import-distribution';release.taskCalendar=true;release.leadImport=true;release.salesDistribution=true;fs.writeFileSync(releasePath,JSON.stringify(release,null,2)+'\n');
console.log('Applied Marktone operations release 1.5.0');
