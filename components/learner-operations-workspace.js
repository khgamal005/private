'use client';

import Link from 'next/link';
import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];

const RUN_STATUS={
  planning:'تحت الإعداد',
  open:'مفتوحة',
  in_progress:'قيد التنفيذ',
  completed:'مكتملة'
};

const ATTENDANCE_STATUS={
  present:'حاضر',
  late:'متأخر',
  absent:'غائب',
  excused:'غياب بعذر'
};

const ATTENDANCE_ACTIONS=[
  ['present','حاضر'],
  ['late','متأخر'],
  ['absent','غائب'],
  ['excused','بعذر']
];

const REASON_LABELS={
  certificate_disabled:'إصدار الشهادة متوقف لهذه الدفعة',
  run_not_completed:'الدفعة لم تكتمل بعد',
  no_sessions:'لا توجد جلسات مسجلة',
  sessions_pending:'توجد جلسات لم تُغلق',
  attendance_incomplete:'لم يُسجل حضور جميع الجلسات',
  attendance_below_threshold:'نسبة الحضور أقل من المطلوب',
  assessment_missing:'التقييم النهائي غير مسجل',
  assessment_below_threshold:'نتيجة التقييم أقل من المطلوب'
};

const FILTERS=[
  ['all','كل الدفعات'],
  ['in_progress','قيد التنفيذ'],
  ['open','مفتوحة'],
  ['completed','مكتملة']
];

const dateTime=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric',
  hour:'2-digit',
  minute:'2-digit'
}):'—';

const percentage=value=>value==null?'—':`${Number(value).toFixed(0)}٪`;

export default function LearnerOperationsWorkspace({slug,data}){
  const router=useRouter();
  const runs=data?.courseRuns||EMPTY;
  const summary=data?.summary||{};
  const canManage=Boolean(data?.viewer?.canManage);
  const firstRun=runs.find(run=>run.status==='in_progress')
    ||runs.find(run=>(run.learners||EMPTY).length)
    ||runs[0];
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [selectedRunId,setSelectedRunId]=useState(firstRun?.id||'');
  const [selectedSessionId,setSelectedSessionId]=useState('');
  const [scoreDrafts,setScoreDrafts]=useState({});
  const [lateDrafts,setLateDrafts]=useState({});
  const [ruleDraft,setRuleDraft]=useState({
    minAttendancePercent:'75',
    minAssessmentPercent:'70'
  });
  const [busyKey,setBusyKey]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  const shownRuns=useMemo(()=>runs.filter(run=>{
    if(filter!=='all'&&run.status!==filter)return false;
    const haystack=`${run.title||''} ${run.runCode||''} ${run.courseName||''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }),[runs,filter,query]);

  const selectedRun=runs.find(run=>run.id===selectedRunId)||firstRun||null;
  const sessions=(selectedRun?.sessions||EMPTY).filter(
    session=>session.status!=='cancelled'
  );
  const selectedSession=sessions.find(
    session=>session.id===selectedSessionId
  )||sessions[0]||null;

  useEffect(()=>{
    if(selectedRunId&&!runs.some(run=>run.id===selectedRunId)){
      setSelectedRunId(firstRun?.id||'');
    }
  },[runs,selectedRunId,firstRun?.id]);

  useEffect(()=>{
    const available=selectedRun?.sessions||EMPTY;
    if(!available.some(session=>session.id===selectedSessionId)){
      setSelectedSessionId(
        available.find(session=>session.status!=='cancelled')?.id||''
      );
    }
    setRuleDraft({
      minAttendancePercent:String(
        selectedRun?.rules?.minAttendancePercent??75
      ),
      minAssessmentPercent:String(
        selectedRun?.rules?.minAssessmentPercent??70
      )
    });
  },[selectedRun,selectedSessionId]);

  async function call(body,successText,key){
    setBusyKey(key);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/update-training-operation',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          ...body
        })
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
      setNotice(successText);
      router.refresh();
      return payload.data;
    }catch(err){
      setError(err.message);
      return null;
    }finally{
      setBusyKey('');
    }
  }

  async function copyJoiningMessage(learner){
    setError('');
    try{
      await navigator.clipboard.writeText(learner.joiningMessage||'');
      setNotice(`تم نسخ رسالة انضمام ${learner.fullName}`);
    }catch{
      setError('تعذر نسخ الرسالة. اسمح للمتصفح باستخدام الحافظة.');
    }
  }

  function markJoiningSent(learner){
    const channel=learner.phone?'whatsapp':learner.email?'email':'manual';
    return call({
      p_action:'mark_joining_sent',
      p_enrollment_id:learner.enrollmentId,
      p_channel:channel
    },`تم تسجيل إرسال رسالة الانضمام إلى ${learner.fullName}`,`join-${learner.enrollmentId}`);
  }

  function markAttendance(learner,status){
    if(!selectedSession)return;
    const minutes=status==='late'
      ?Math.max(Number(lateDrafts[learner.enrollmentId]||5),1)
      :0;
    return call({
      p_action:'set_attendance',
      p_enrollment_id:learner.enrollmentId,
      p_session_id:selectedSession.id,
      p_attendance_status:status,
      p_minutes_late:minutes
    },`تم تسجيل ${ATTENDANCE_STATUS[status]} لـ ${learner.fullName}`,`attendance-${learner.enrollmentId}-${status}`);
  }

  function saveAssessment(learner){
    const value=scoreDrafts[learner.enrollmentId]
      ??learner.assessment?.percent
      ??'';
    if(value===''||Number.isNaN(Number(value))){
      setError('أدخل نتيجة التقييم أولًا.');
      return;
    }
    return call({
      p_action:'save_assessment',
      p_enrollment_id:learner.enrollmentId,
      p_score:Number(value),
      p_max_score:100
    },`تم حفظ تقييم ${learner.fullName}`,`assessment-${learner.enrollmentId}`);
  }

  function saveRules(){
    return call({
      p_action:'update_rules',
      p_course_run_id:selectedRun.id,
      p_min_attendance_percent:Number(ruleDraft.minAttendancePercent),
      p_min_assessment_percent:Number(ruleDraft.minAssessmentPercent)
    },'تم تحديث قواعد أهلية الشهادة لهذه الدفعة','rules');
  }

  function issueCertificate(learner){
    return call({
      p_action:'issue_certificate',
      p_enrollment_id:learner.enrollmentId
    },`تم إصدار شهادة ${learner.fullName}`,`certificate-${learner.enrollmentId}`);
  }

  return <section className="mt-training-operations" dir="rtl">
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis mt-training-kpis">
      <article className="mt-kpi">
        <span>متدربون نشطون</span>
        <b>{summary.activeLearners||0}</b>
        <small>مؤكدون أو داخل التدريب</small>
      </article>
      <article className="mt-kpi">
        <span>جلسات اليوم</span>
        <b>{summary.todaySessions||0}</b>
        <small>حسب توقيت المنشأة</small>
      </article>
      <article className="mt-kpi">
        <span>سجلات الحضور</span>
        <b>{summary.attendanceRecords||0}</b>
        <small>نتائج حضور فعلية</small>
      </article>
      <article className="mt-kpi warning">
        <span>جاهزون للشهادة</span>
        <b>{summary.readyCertificates||0}</b>
        <small>استوفوا الشروط ولم تصدر بعد</small>
      </article>
      <article className="mt-kpi success">
        <span>شهادات صادرة</span>
        <b>{summary.issuedCertificates||0}</b>
        <small>بسجل تحقق مستقل</small>
      </article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar mt-training-toolbar">
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
          placeholder="ابحث باسم الدورة أو الدفعة أو الكود"
        />
      </div>

      <div className="mt-training-run-strip">
        {shownRuns.map(run=><button
          key={run.id}
          className={selectedRun?.id===run.id?'active':''}
          onClick={()=>setSelectedRunId(run.id)}
        >
          <span className={`mt-status ${run.status}`}>
            {RUN_STATUS[run.status]||run.status}
          </span>
          <b>{run.title}</b>
          <small>{run.courseName} · {run.runCode}</small>
          <div>
            <span>{run.summary?.learners||0} متدرب</span>
            <span>{run.summary?.completedSessions||0}/{run.summary?.sessions||0} جلسة</span>
          </div>
          {run.demo&&<em>بيانات تجريبية</em>}
        </button>)}
        {!shownRuns.length&&<div className="mt-empty">
          لا توجد دفعات مطابقة.
        </div>}
      </div>
    </section>

    {selectedRun&&<section className="mt-training-board">
      <header className="mt-training-board-head">
        <div>
          <small>LEARNER OPERATIONS</small>
          <h3>{selectedRun.title}</h3>
          <p>{selectedRun.courseName} · {dateTime(selectedRun.startsAt)} · {selectedRun.instructorName||'لم يحدد المدرب'}</p>
        </div>
        <div className="mt-training-rule-editor">
          <label>الحد الأدنى للحضور<input
            type="number"
            min="0"
            max="100"
            value={ruleDraft.minAttendancePercent}
            onChange={event=>setRuleDraft(current=>({
              ...current,
              minAttendancePercent:event.target.value
            }))}
            disabled={!canManage}
          /></label>
          <label>الحد الأدنى للتقييم<input
            type="number"
            min="0"
            max="100"
            value={ruleDraft.minAssessmentPercent}
            onChange={event=>setRuleDraft(current=>({
              ...current,
              minAssessmentPercent:event.target.value
            }))}
            disabled={!canManage}
          /></label>
          {canManage&&<button
            onClick={saveRules}
            disabled={busyKey==='rules'}
          >{busyKey==='rules'?'جارٍ الحفظ…':'حفظ القواعد'}</button>}
        </div>
      </header>

      <section className="mt-training-session-picker">
        <header>
          <div>
            <h4>الحضور حسب الجلسة</h4>
            <small>اختر الجلسة ثم سجل نتيجة كل متدرب</small>
          </div>
          {selectedSession&&<span>
            {dateTime(selectedSession.startsAt)} · {selectedSession.title}
          </span>}
        </header>
        <div>
          {sessions.map(session=><button
            key={session.id}
            className={selectedSession?.id===session.id?'active':''}
            onClick={()=>setSelectedSessionId(session.id)}
          >
            <b>{session.sessionNumber}</b>
            <span>{session.title}</span>
            <small>{session.status==='completed'?'مغلقة':'مجدولة'}</small>
          </button>)}
          {!sessions.length&&<div className="mt-empty compact">
            لا توجد جلسات في هذه الدفعة.
          </div>}
        </div>
      </section>

      <div className="mt-learner-grid">
        {(selectedRun.learners||EMPTY).map(learner=><LearnerCard
          key={learner.enrollmentId}
          slug={slug}
          learner={learner}
          selectedSession={selectedSession}
          canManage={canManage}
          busyKey={busyKey}
          scoreValue={scoreDrafts[learner.enrollmentId]
            ??learner.assessment?.percent
            ??''}
          lateValue={lateDrafts[learner.enrollmentId]??5}
          onScoreChange={value=>setScoreDrafts(current=>({
            ...current,
            [learner.enrollmentId]:value
          }))}
          onLateChange={value=>setLateDrafts(current=>({
            ...current,
            [learner.enrollmentId]:value
          }))}
          onCopy={()=>copyJoiningMessage(learner)}
          onMarkJoining={()=>markJoiningSent(learner)}
          onAttendance={status=>markAttendance(learner,status)}
          onSaveAssessment={()=>saveAssessment(learner)}
          onIssueCertificate={()=>issueCertificate(learner)}
        />)}
        {!(selectedRun.learners||EMPTY).length&&<div className="mt-empty">
          لا يوجد متدربون في هذه الدفعة بعد.
        </div>}
      </div>
    </section>}
  </section>;
}

function LearnerCard({
  slug,
  learner,
  selectedSession,
  canManage,
  busyKey,
  scoreValue,
  lateValue,
  onScoreChange,
  onLateChange,
  onCopy,
  onMarkJoining,
  onAttendance,
  onSaveAssessment,
  onIssueCertificate
}){
  const attendance=selectedSession
    ?learner.attendance?.[selectedSession.id]
    :null;
  const eligibility=learner.eligibility||{};
  const certificate=learner.certificate;
  const joiningSent=learner.joining?.status==='sent';
  const attendanceBusy=busyKey.startsWith(
    `attendance-${learner.enrollmentId}-`
  );

  return <article className="mt-learner-card">
    <header>
      <div>
        <h4>{learner.fullName}</h4>
        <small>{learner.studentNumber} · {learner.phone||learner.email||'لا توجد وسيلة تواصل'}</small>
      </div>
      {learner.demo&&<span className="mt-demo-badge">تجريبي</span>}
    </header>

    <section className="mt-learner-joining">
      <div>
        <b>رسالة الانضمام</b>
        <small>{joiningSent
          ?`سُجل إرسالها ${dateTime(learner.joining.sentAt)}`
          :'جاهزة للنسخ والإرسال'}</small>
      </div>
      <div>
        <button onClick={onCopy}>نسخ الرسالة</button>
        {canManage&&!joiningSent&&<button
          className="primary"
          onClick={onMarkJoining}
          disabled={busyKey===`join-${learner.enrollmentId}`}
        >تأكيد الإرسال يدويًا</button>}
      </div>
    </section>

    <section className="mt-learner-attendance">
      <header>
        <div>
          <b>{selectedSession?.title||'اختر جلسة'}</b>
          <small>{attendance
            ?`الحالة الحالية: ${ATTENDANCE_STATUS[attendance.status]}`
            :'لم يسجل الحضور بعد'}</small>
        </div>
        <span className={attendance?.status||'pending'}>
          {attendance?ATTENDANCE_STATUS[attendance.status]:'معلق'}
        </span>
      </header>
      {canManage&&selectedSession&&<div className="mt-attendance-actions">
        {ATTENDANCE_ACTIONS.map(([key,label])=><button
          key={key}
          className={attendance?.status===key?`active ${key}`:key}
          onClick={()=>onAttendance(key)}
          disabled={attendanceBusy}
        >{label}</button>)}
        <label>دقائق التأخير<input
          type="number"
          min="1"
          max="1440"
          value={lateValue}
          onChange={event=>onLateChange(event.target.value)}
        /></label>
      </div>}
    </section>

    <section className="mt-learner-evaluation">
      <div className="mt-learner-metrics">
        <div><span>الحضور</span><b>{percentage(eligibility.attendancePercent)}</b></div>
        <div><span>التقييم</span><b>{percentage(eligibility.assessmentPercent)}</b></div>
        <div><span>الجلسات</span><b>{eligibility.recordedSessions||0}/{eligibility.totalSessions||0}</b></div>
      </div>
      <div className="mt-assessment-control">
        <label>التقييم النهائي من 100<input
          type="number"
          min="0"
          max="100"
          value={scoreValue}
          onChange={event=>onScoreChange(event.target.value)}
          disabled={!canManage}
        /></label>
        {canManage&&<button
          onClick={onSaveAssessment}
          disabled={busyKey===`assessment-${learner.enrollmentId}`}
        >حفظ التقييم</button>}
      </div>
    </section>

    <section className={`mt-certificate-state ${eligibility.eligible?'eligible':'pending'}`}>
      <div>
        <b>{certificate?.status==='issued'
          ?'تم إصدار الشهادة'
          :eligibility.eligible
            ?'مؤهل لإصدار الشهادة'
            :'لم تكتمل الأهلية'}</b>
        <small>{certificate?.certificateNumber
          ||(eligibility.reasons||EMPTY)
            .map(reason=>REASON_LABELS[reason]||reason)
            .join(' · ')
          ||'جميع الشروط مكتملة'}</small>
      </div>
      {certificate&&<Link
        href={`/tenant/${encodeURIComponent(slug)}/certificates/${encodeURIComponent(certificate.id)}`}
        target="_blank"
        rel="noreferrer"
      >عرض وطباعة</Link>}
      {canManage&&!certificate&&eligibility.eligible&&<button
        onClick={onIssueCertificate}
        disabled={busyKey===`certificate-${learner.enrollmentId}`}
      >إصدار الشهادة</button>}
    </section>
  </article>;
}
