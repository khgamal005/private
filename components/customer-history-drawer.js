'use client';

import {useEffect,useMemo,useState} from 'react';
import {FollowupDetailsSummary} from './sales-followup-details';
import {
  ACTIONS,
  SalesQualityBadge,
  SalesStatusBadge
} from './sales-followup-modal';

const EMPTY_HISTORY={contact:{},summary:{},events:[]};

const FILTERS=[
  ['all','كل السجل'],
  ['followups','المواعيد والمتابعات'],
  ['sales','المبيعات والحالة'],
  ['admissions','الدفع والتسجيل'],
  ['communications','التواصل والمكالمات'],
  ['exceptions','المتأخر والمتجاوز']
];

const TIMING={
  early:{label:'تم مبكرًا',tone:'early'},
  on_time:{label:'في الموعد',tone:'on-time'},
  late:{label:'تم متأخرًا',tone:'late'},
  overdue:{label:'متأخر ولم يُنفّذ',tone:'overdue'},
  pending:{label:'قادم',tone:'pending'},
  cancelled:{label:'ملغي',tone:'cancelled'},
  not_scheduled:{label:'إجراء مسجل',tone:'recorded'}
};

const TYPE_META={
  contact:{icon:'＋',label:'إنشاء العميل'},
  assignment:{icon:'⇢',label:'الإسناد'},
  activity:{icon:'✓',label:'متابعة'},
  task:{icon:'◷',label:'مهمة'},
  status:{icon:'↻',label:'الحالة'},
  payment:{icon:'﷼',label:'الدفع'},
  admission:{icon:'▣',label:'التسجيل والقبول'},
  enrollment:{icon:'◆',label:'التسجيل'},
  communication:{icon:'✉',label:'رسالة'},
  call:{icon:'☎',label:'مكالمة'},
  conversion:{icon:'◎',label:'تحويل تسويقي'}
};

const DATE_FORMAT=new Intl.DateTimeFormat('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric',
  hour:'2-digit',
  minute:'2-digit'
});

function dateTime(value){
  if(!value)return 'لم يُنفّذ بعد';
  const valueDate=new Date(value);
  return Number.isNaN(valueDate.getTime())?'غير محدد':DATE_FORMAT.format(valueDate);
}

function delayCopy(event){
  const minutes=Number(event.delayMinutes);
  if(!Number.isFinite(minutes)||event.timingStatus==='not_scheduled')return '';
  const followsDayPolicy=['task','activity'].includes(event.type);
  if(followsDayPolicy){
    if(event.timingStatus==='early')return 'نُفّذ قبل يوم المتابعة';
    if(event.timingStatus==='late')return 'نُفّذ بعد يوم المتابعة';
    if(event.timingStatus==='on_time')return 'نُفّذ خلال يوم المتابعة المحدد';
    return '';
  }
  const absolute=Math.abs(minutes);
  const hours=Math.floor(absolute/60);
  const rest=absolute%60;
  const duration=hours
    ?`${hours} س${rest?` و${rest} د`:''}`
    :`${rest} دقيقة`;
  if(event.timingStatus==='early')return `قبل الموعد بـ ${duration}`;
  if(event.timingStatus==='late')return `بعد الموعد بـ ${duration}`;
  if(event.timingStatus==='on_time')return 'نُفّذ قبل أو عند الموعد المحدد';
  return '';
}

function matchesFilter(event,filter){
  if(filter==='all')return true;
  if(filter==='followups'){
    return ['activity','task','assignment'].includes(event.type);
  }
  if(filter==='sales'){
    return ['activity','status','assignment','conversion','contact'].includes(event.type);
  }
  if(filter==='admissions'){
    return ['payment','admission','enrollment'].includes(event.type);
  }
  if(filter==='communications'){
    return ['communication','call'].includes(event.type);
  }
  if(filter==='exceptions'){
    return ['late','overdue','cancelled'].includes(event.timingStatus);
  }
  return true;
}

export default function CustomerHistoryDrawer({
  slug,
  contact,
  canEdit=false,
  onEdit,
  onClose
}){
  const [data,setData]=useState(EMPTY_HISTORY);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState('all');

  useEffect(()=>{
    const controller=new AbortController();
    async function load(){
      setBusy(true);
      setError('');
      setData(EMPTY_HISTORY);
      try{
        const params=new URLSearchParams({
          tenantSlug:slug,
          contactId:contact.id
        });
        const response=await fetch(
          `/api/tenant/customer-history?${params.toString()}`,
          {cache:'no-store',signal:controller.signal}
        );
        const payload=await response.json().catch(()=>({}));
        if(!response.ok){
          throw new Error(payload.error||'تعذر تحميل سجل العميل');
        }
        setData(payload.data||EMPTY_HISTORY);
      }catch(loadError){
        if(loadError.name!=='AbortError'){
          setError(loadError.message||'تعذر تحميل سجل العميل');
        }
      }finally{
        if(!controller.signal.aborted)setBusy(false);
      }
    }
    load();
    return ()=>controller.abort();
  },[contact.id,slug]);

  useEffect(()=>{
    function onKeyDown(event){
      if(event.key==='Escape')onClose();
    }
    document.addEventListener('keydown',onKeyDown);
    return ()=>document.removeEventListener('keydown',onKeyDown);
  },[onClose]);

  const events=useMemo(
    ()=>(data.events||[]).filter(event=>matchesFilter(event,filter)),
    [data.events,filter]
  );
  const summary=data.summary||{};
  const resolvedContact=data.contact?.id?data.contact:contact;

  return <div className="mt-customer-history-layer">
    <button
      className="mt-customer-history-backdrop"
      aria-label="إغلاق سجل العميل"
      onClick={onClose}
    />
    <aside
      className="mt-customer-history-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-history-title"
    >
      <header className="mt-customer-history-head">
        <div className="mt-customer-history-person">
          <span>{Array.from(resolvedContact.name||'ع')[0]}</span>
          <div>
            <small>سجل العميل الكامل</small>
            <h2 id="customer-history-title">{resolvedContact.name}</h2>
            <p>{resolvedContact.phone||resolvedContact.email||'لا توجد وسيلة تواصل'}</p>
          </div>
        </div>
        <div className="mt-customer-history-head-actions">
          {canEdit&&<button className="mt-button soft" onClick={onEdit}>تعديل البيانات</button>}
          <button onClick={onClose} aria-label="إغلاق">×</button>
        </div>
      </header>

      {!busy&&!error&&<>
        <section className="mt-customer-history-context">
          <div>
            <span>الحالة الحالية</span>
            <SalesStatusBadge value={resolvedContact.leadStatus}/>
          </div>
          <div>
            <span>جودة العميل</span>
            <SalesQualityBadge value={resolvedContact.leadQuality}/>
          </div>
          <div><span>المسؤول</span><b>{resolvedContact.ownerName||'غير مسند'}</b></div>
          <div><span>الدورة</span><b>{resolvedContact.courseName||resolvedContact.interestCourseName||'غير محددة'}</b></div>
          {resolvedContact.nextActionAt&&<div className="wide">
            <span>الإجراء القادم</span>
            <b>{ACTIONS[resolvedContact.nextActionType]||resolvedContact.nextActionType} · {dateTime(resolvedContact.nextActionAt)}</b>
          </div>}
        </section>

        <FollowupDetailsSummary contact={resolvedContact} timezone={data?.timezone}/>
        {resolvedContact.notes&&<section className="mt-customer-history-context">
          <div className="wide">
            <span>ملاحظات العميل</span>
            <b>{resolvedContact.notes}</b>
          </div>
        </section>}

        <section className="mt-customer-history-summary">
          <article><span>كل الإجراءات</span><b>{summary.totalEvents||0}</b><small>من جميع الأقسام</small></article>
          <article className="good"><span>خلال اليوم المحدد</span><b>{summary.completedOnTime||0}</b><small>يشمل المنفّذ في يوم أبكر</small></article>
          <article className="late"><span>تم متأخرًا</span><b>{summary.completedLate||0}</b><small>بعد يوم المتابعة المحدد</small></article>
          <article className="danger"><span>تجاوز يوم المتابعة</span><b>{summary.overdue||0}</b><small>انتهى اليوم دون تنفيذ</small></article>
          <article className="rate"><span>نسبة الالتزام</span><b>{Number(summary.adherencePercent)||0}%</b><small>من الإجراءات المنفذة</small></article>
        </section>

        <nav className="mt-customer-history-filters" aria-label="تصفية سجل العميل">
          {FILTERS.map(([key,label])=><button
            key={key}
            className={filter===key?'active':''}
            onClick={()=>setFilter(key)}
          >{label}</button>)}
        </nav>
      </>}

      <div className="mt-customer-history-body" aria-live="polite" aria-busy={busy}>
        {busy&&<div className="mt-customer-history-state">
          <span className="mt-customer-history-spinner"/>
          <b>جارٍ تجميع كل إجراءات العميل…</b>
          <p>المتابعات والمهام والدفع والتسجيل والرسائل والمكالمات.</p>
        </div>}

        {error&&<div className="mt-customer-history-state error">
          <b>تعذر تحميل السجل</b>
          <p>{error}</p>
          <button className="mt-button" onClick={onClose}>إغلاق</button>
        </div>}

        {!busy&&!error&&<div className="mt-customer-timeline">
          {events.map(event=><HistoryEvent event={event} key={event.id}/>) }
          {!events.length&&<div className="mt-customer-history-state">
            <b>لا توجد إجراءات في هذا التصنيف</b>
            <p>اختر «كل السجل» لعرض التسلسل الزمني بالكامل.</p>
          </div>}
        </div>}
      </div>
    </aside>
  </div>;
}

function HistoryEvent({event}){
  const type=TYPE_META[event.type]||{icon:'•',label:'إجراء'};
  const timing=TIMING[event.timingStatus]||TIMING.not_scheduled;
  const delay=delayCopy(event);
  const fromStatus=event.details?.fromStatus;
  const toStatus=event.details?.toStatus;
  return <article className={`mt-customer-timeline-event timing-${timing.tone}`}>
    <div className="mt-customer-timeline-marker">
      <span>{type.icon}</span>
    </div>
    <div className="mt-customer-timeline-card">
      <header>
        <div><small>{type.label}</small><h3>{event.title}</h3></div>
        <span className={`mt-customer-timing ${timing.tone}`}>{timing.label}</span>
      </header>

      {event.description&&<p><b>الملاحظات: </b>{event.description}</p>}
      {fromStatus&&toStatus&&<div className="mt-customer-status-change">
        <SalesStatusBadge value={fromStatus}/><span>←</span><SalesStatusBadge value={toStatus}/>
      </div>}

      <dl className="mt-customer-history-dates">
        {event.scheduledAt&&<div><dt>الموعد المحدد</dt><dd>{dateTime(event.scheduledAt)}</dd></div>}
        <div><dt>{event.scheduledAt?'التنفيذ الفعلي':'وقت التسجيل'}</dt><dd>{dateTime(event.occurredAt||event.recordedAt)}</dd></div>
        {delay&&<div className="wide"><dt>الالتزام</dt><dd>{delay}</dd></div>}
      </dl>

      <footer>
        <span>بواسطة: <b>{event.actorName||'إدارة المنشأة'}</b></span>
        {event.nextActionAt&&<span>التالي: <b>{ACTIONS[event.nextActionType]||event.nextActionType} · {dateTime(event.nextActionAt)}</b></span>}
      </footer>
    </div>
  </article>;
}
