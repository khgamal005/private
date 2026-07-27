'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];

const STATUS_LABELS={
  planning:'تحت الإعداد',
  open:'مفتوحة للتسجيل',
  in_progress:'قيد التنفيذ',
  completed:'مكتملة',
  cancelled:'ملغاة'
};

const DELIVERY_LABELS={
  online:'عن بُعد',
  onsite:'حضوري',
  hybrid:'هجين'
};

const FILTERS=[
  ['all','الكل'],
  ['open','مفتوحة'],
  ['planning','تحت الإعداد'],
  ['in_progress','قيد التنفيذ'],
  ['completed','مكتملة']
];

export default function CourseRunsWorkspace({slug,data}){
  const router=useRouter();
  const courses=data.courses||EMPTY;
  const runs=data.courseRuns||EMPTY;
  const summary=data.batchSummary||{};
  const timezone=data.timezone||'Asia/Riyadh';
  const canManage=Boolean(data.viewer?.canManageBatches);
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [draft,setDraft]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');

  const shown=useMemo(()=>runs.filter(run=>{
    if(filter!=='all'&&run.status!==filter)return false;
    const haystack=`${run.title||''} ${run.runCode||''} ${run.courseName||''} ${run.instructorName||''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }),[runs,filter,query]);

  function openNew(){
    const course=courses[0]||{};
    setDraft({
      id:null,
      courseId:course.id||'',
      runCode:'',
      title:course.nameAr?`دفعة ${course.nameAr}`:'',
      deliveryMode:course.deliveryMode||'hybrid',
      startsLocal:'',
      endsLocal:'',
      registrationOpensLocal:'',
      registrationClosesLocal:'',
      capacity:'20',
      instructorName:'',
      venueOrLink:'',
      price:'',
      status:'planning',
      sessions:[emptySession(course.deliveryMode||'hybrid')]
    });
    setError('');
    setNotice('');
  }

  function openEdit(run){
    setDraft({
      id:run.id,
      courseId:run.courseId,
      runCode:run.runCode||'',
      title:run.title||'',
      deliveryMode:run.deliveryMode||'hybrid',
      startsLocal:toLocalInput(run.startsAt,timezone),
      endsLocal:toLocalInput(run.endsAt,timezone),
      registrationOpensLocal:toLocalInput(run.registrationOpensAt,timezone),
      registrationClosesLocal:toLocalInput(run.registrationClosesAt,timezone),
      capacity:String(run.capacity||''),
      instructorName:run.instructorName||'',
      venueOrLink:run.venueOrLink||'',
      price:run.priceMinor==null?'':String(Number(run.priceMinor)/100),
      status:run.status,
      sessions:(run.sessions||EMPTY).map(session=>({
        title:session.title||'',
        startsAt:toLocalInput(session.startsAt,timezone),
        endsAt:toLocalInput(session.endsAt,timezone),
        deliveryMode:session.deliveryMode||run.deliveryMode||'hybrid',
        instructorName:session.instructorName||'',
        venueOrLink:session.venueOrLink||''
      }))
    });
    setError('');
    setNotice('');
  }

  function close(){
    if(busy)return;
    setDraft(null);
    setError('');
  }

  function setField(key,value){
    setDraft(current=>({...current,[key]:value}));
  }

  function changeCourse(courseId){
    const course=courses.find(item=>item.id===courseId);
    setDraft(current=>({
      ...current,
      courseId,
      deliveryMode:course?.deliveryMode||current.deliveryMode,
      title:current.id||!course?.nameAr
        ?current.title
        :`دفعة ${course.nameAr}`
    }));
  }

  function updateSession(index,key,value){
    setDraft(current=>({
      ...current,
      sessions:current.sessions.map((session,position)=>
        position===index?{...session,[key]:value}:session
      )
    }));
  }

  function addSession(){
    setDraft(current=>({
      ...current,
      sessions:[
        ...current.sessions,
        emptySession(current.deliveryMode)
      ]
    }));
  }

  function removeSession(index){
    setDraft(current=>({
      ...current,
      sessions:current.sessions.filter((_,position)=>position!==index)
    }));
  }

  async function save(event){
    event.preventDefault();
    if(!draft)return;
    if(!draft.sessions.length&&['open','in_progress'].includes(draft.status)){
      setError('أضف موعد محاضرة واحدًا على الأقل قبل فتح الدفعة.');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/save-course-run',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_course_run_id:draft.id,
          p_course_id:draft.courseId,
          p_title:draft.title,
          p_run_code:draft.runCode||null,
          p_delivery_mode:draft.deliveryMode,
          p_starts_local:draft.startsLocal,
          p_ends_local:draft.endsLocal,
          p_capacity:Number(draft.capacity),
          p_instructor_name:draft.instructorName||null,
          p_venue_or_link:draft.venueOrLink||null,
          p_price_minor:draft.price===''?null:Math.round(Number(draft.price)*100),
          p_registration_opens_local:draft.registrationOpensLocal||null,
          p_registration_closes_local:draft.registrationClosesLocal||null,
          p_status:draft.status,
          p_sessions:draft.sessions.map(session=>({
            title:session.title,
            startsAt:session.startsAt,
            endsAt:session.endsAt,
            deliveryMode:session.deliveryMode||draft.deliveryMode,
            instructorName:session.instructorName||null,
            venueOrLink:session.venueOrLink||null
          }))
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر حفظ الدفعة');
      setNotice(draft.id?'تم تحديث الدفعة وجدولها.':'تم إنشاء الدفعة وجدولها.');
      setDraft(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  return <>
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&!draft&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis mt-batch-kpis">
      <button className="mt-kpi" onClick={()=>setFilter('all')}>
        <span>إجمالي الدفعات</span>
        <b>{summary.totalBatches||0}</b>
        <small>باستثناء الملغاة</small>
      </button>
      <button className="mt-kpi success" onClick={()=>setFilter('open')}>
        <span>مفتوحة للتسجيل</span>
        <b>{summary.openBatches||0}</b>
        <small>يمكن تسكين المتدربين بها</small>
      </button>
      <button className="mt-kpi" onClick={()=>setFilter('planning')}>
        <span>تحت الإعداد</span>
        <b>{summary.planningBatches||0}</b>
        <small>لم تفتح للتسجيل بعد</small>
      </button>
      <article className="mt-kpi">
        <span>تبدأ خلال 30 يومًا</span>
        <b>{summary.upcomingBatches||0}</b>
        <small>دفعات قريبة الانطلاق</small>
      </article>
      <article className="mt-kpi">
        <span>المحاضرات المجدولة</span>
        <b>{summary.scheduledSessions||0}</b>
        <small>داخل جميع الدفعات</small>
      </article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar mt-batches-toolbar">
        <div className="mt-segmented">
          {FILTERS.map(([key,label])=><button
            key={key}
            className={filter===key?'active':''}
            onClick={()=>setFilter(key)}
          >{label}</button>)}
        </div>
        <input
          className="mt-search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث باسم الدفعة أو الدورة أو الكود"
        />
        {canManage&&<button className="mt-button primary" onClick={openNew}>
          + دفعة جديدة
        </button>}
      </div>

      <div className="mt-batch-grid">
        {shown.map(run=><BatchCard
          key={run.id}
          run={run}
          timezone={timezone}
          canManage={canManage}
          onEdit={()=>openEdit(run)}
        />)}
        {!shown.length&&<div className="mt-empty">
          لا توجد دفعات مطابقة. أنشئ أول دفعة وحدد جدول المحاضرات.
        </div>}
      </div>
    </section>

    {draft&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" onClick={close} aria-label="إغلاق"/>
      <form className="mt-modal mt-batch-modal" onSubmit={save}>
        <header>
          <div>
            <small>COURSE RUN & SCHEDULE</small>
            <h3>{draft.id?'تعديل الدفعة والجدول':'إنشاء دفعة وجدول'}</h3>
          </div>
          <button type="button" onClick={close}>×</button>
        </header>

        <div className="mt-batch-form-body">
          <section className="mt-batch-details">
            <h4>بيانات الدفعة</h4>
            <div className="mt-form">
              <label className="mt-field">الدورة<select
                value={draft.courseId}
                onChange={event=>changeCourse(event.target.value)}
                required
              >
                <option value="">اختر الدورة</option>
                {courses.map(course=><option value={course.id} key={course.id}>
                  {course.nameAr}
                </option>)}
              </select></label>
              <label className="mt-field">حالة الدفعة<select
                value={draft.status}
                onChange={event=>setField('status',event.target.value)}
              >
                <option value="planning">تحت الإعداد</option>
                <option value="open">مفتوحة للتسجيل</option>
                {draft.id&&<option value="in_progress">قيد التنفيذ</option>}
                {draft.id&&<option value="completed">مكتملة</option>}
                {draft.id&&<option value="cancelled">ملغاة</option>}
              </select></label>
              <label className="mt-field wide">اسم الدفعة<input
                value={draft.title}
                onChange={event=>setField('title',event.target.value)}
                required
              /></label>
              <label className="mt-field">كود الدفعة<input
                dir="ltr"
                value={draft.runCode}
                onChange={event=>setField('runCode',event.target.value)}
                placeholder="يُنشأ تلقائيًا عند تركه فارغًا"
              /></label>
              <label className="mt-field">طريقة التقديم<select
                value={draft.deliveryMode}
                onChange={event=>setField('deliveryMode',event.target.value)}
              >
                <option value="hybrid">هجين</option>
                <option value="online">عن بُعد</option>
                <option value="onsite">حضوري</option>
              </select></label>
              <label className="mt-field">بداية الدفعة<input
                type="datetime-local"
                value={draft.startsLocal}
                onChange={event=>setField('startsLocal',event.target.value)}
                required
              /></label>
              <label className="mt-field">نهاية الدفعة<input
                type="datetime-local"
                value={draft.endsLocal}
                onChange={event=>setField('endsLocal',event.target.value)}
                required
              /></label>
              <label className="mt-field">فتح التسجيل<input
                type="datetime-local"
                value={draft.registrationOpensLocal}
                onChange={event=>setField('registrationOpensLocal',event.target.value)}
              /></label>
              <label className="mt-field">إغلاق التسجيل<input
                type="datetime-local"
                value={draft.registrationClosesLocal}
                onChange={event=>setField('registrationClosesLocal',event.target.value)}
              /></label>
              <label className="mt-field">السعة<input
                type="number"
                min="1"
                max="100000"
                value={draft.capacity}
                onChange={event=>setField('capacity',event.target.value)}
                required
              /></label>
              <label className="mt-field">السعر بالريال — اختياري<input
                type="number"
                min="0"
                step=".01"
                value={draft.price}
                onChange={event=>setField('price',event.target.value)}
              /></label>
              <label className="mt-field">المدرب<input
                value={draft.instructorName}
                onChange={event=>setField('instructorName',event.target.value)}
                placeholder="يمكن تحديده لاحقًا"
              /></label>
              <label className="mt-field">القاعة أو رابط الدخول<input
                value={draft.venueOrLink}
                onChange={event=>setField('venueOrLink',event.target.value)}
                placeholder="يمكن تحديده لاحقًا"
              /></label>
            </div>
            <p className="mt-timezone-note">جميع المواعيد بتوقيت المنشأة: {timezone}</p>
          </section>

          <section className="mt-session-editor">
            <header>
              <div>
                <h4>جدول المحاضرات</h4>
                <small>{draft.sessions.length} محاضرة</small>
              </div>
              <button type="button" onClick={addSession}>+ إضافة محاضرة</button>
            </header>
            <div>
              {draft.sessions.map((session,index)=><article key={index}>
                <div className="mt-session-number">{index+1}</div>
                <label>اسم المحاضرة<input
                  value={session.title}
                  onChange={event=>updateSession(index,'title',event.target.value)}
                  placeholder={`المحاضرة ${index+1}`}
                /></label>
                <label>البداية<input
                  type="datetime-local"
                  value={session.startsAt}
                  onChange={event=>updateSession(index,'startsAt',event.target.value)}
                  required
                /></label>
                <label>النهاية<input
                  type="datetime-local"
                  value={session.endsAt}
                  onChange={event=>updateSession(index,'endsAt',event.target.value)}
                  required
                /></label>
                <label>طريقة التقديم<select
                  value={session.deliveryMode}
                  onChange={event=>updateSession(index,'deliveryMode',event.target.value)}
                >
                  <option value="hybrid">هجين</option>
                  <option value="online">عن بُعد</option>
                  <option value="onsite">حضوري</option>
                </select></label>
                <button
                  className="danger"
                  type="button"
                  onClick={()=>removeSession(index)}
                  aria-label="حذف المحاضرة"
                >حذف</button>
              </article>)}
              {!draft.sessions.length&&<div className="mt-empty">
                لم تضف مواعيد محاضرات بعد.
              </div>}
            </div>
          </section>

          {error&&<div className="mt-alert error">{error}</div>}
        </div>

        <footer>
          <button type="button" className="mt-button" onClick={close}>إلغاء</button>
          <button className="mt-button primary" disabled={busy}>
            {busy?'جارٍ الحفظ…':'حفظ الدفعة والجدول'}
          </button>
        </footer>
      </form>
    </div>}
  </>;
}

function BatchCard({run,timezone,canManage,onEdit}){
  const capacity=Number(run.capacity||0);
  const enrolled=Number(run.enrolledCount||0);
  const occupancy=capacity?Math.min(100,Math.round(enrolled/capacity*100)):0;
  const sessions=run.sessions||EMPTY;

  return <article className={`mt-batch-card status-${run.status}`}>
    <header>
      <div>
        <div className="mt-batch-badges">
          <span className={`mt-status ${run.status}`}>{STATUS_LABELS[run.status]||run.status}</span>
          {run.demo&&<span className="mt-demo-badge">بيانات تجريبية</span>}
        </div>
        <h3>{run.title}</h3>
        <small>{run.courseName} · <span dir="ltr">{run.runCode}</span></small>
      </div>
      {canManage&&<button onClick={onEdit}>تعديل</button>}
    </header>

    <dl>
      <div><dt>البداية</dt><dd>{formatDateTime(run.startsAt,timezone)}</dd></div>
      <div><dt>النهاية</dt><dd>{formatDateTime(run.endsAt,timezone)}</dd></div>
      <div><dt>التقديم</dt><dd>{DELIVERY_LABELS[run.deliveryMode]||run.deliveryMode}</dd></div>
      <div><dt>المدرب</dt><dd>{run.instructorName||'يحدد لاحقًا'}</dd></div>
    </dl>

    <div className="mt-batch-capacity">
      <div><b>المقاعد</b><span>{enrolled} من {capacity||'غير محدد'}</span></div>
      <progress value={occupancy} max="100"/>
      <small>
        {run.registrationOpen
          ?`${run.availableSeats} مقعدًا متاحًا للتسجيل`
          :'التسجيل غير متاح حاليًا'}
      </small>
    </div>

    <section className="mt-session-preview">
      <header><b>جدول المحاضرات</b><span>{sessions.length}</span></header>
      {sessions.slice(0,3).map(session=><div key={session.id}>
        <span>{session.sessionNumber}</span>
        <div>
          <b>{session.title}</b>
          <small>{formatDateTime(session.startsAt,timezone)} — {timeOnly(session.endsAt,timezone)}</small>
        </div>
      </div>)}
      {sessions.length>3&&<small className="mt-more-sessions">
        + {sessions.length-3} محاضرات أخرى
      </small>}
      {!sessions.length&&<div className="mt-empty compact">لم يحدد الجدول بعد.</div>}
    </section>
  </article>;
}

function emptySession(deliveryMode){
  return {
    title:'',
    startsAt:'',
    endsAt:'',
    deliveryMode:deliveryMode||'hybrid',
    instructorName:'',
    venueOrLink:''
  };
}

function toLocalInput(value,timeZone){
  if(!value)return '';
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone,
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit',
    hourCycle:'h23'
  }).formatToParts(new Date(value));
  const map=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

function formatDateTime(value,timeZone){
  if(!value)return 'غير محدد';
  return new Date(value).toLocaleString('ar-SA',{
    timeZone,
    day:'numeric',
    month:'short',
    year:'numeric',
    hour:'2-digit',
    minute:'2-digit'
  });
}

function timeOnly(value,timeZone){
  if(!value)return '—';
  return new Date(value).toLocaleTimeString('ar-SA',{
    timeZone,
    hour:'2-digit',
    minute:'2-digit'
  });
}
