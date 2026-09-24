'use client';

import Link from 'next/link';
import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import ZoomWorkspace from './zoom-workspace';
import {zoomLegacyMeetingVisible} from '../lib/zoom-setup.mjs';

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

const PROVIDER_LABELS={
  whatsapp_cloud:'WhatsApp Cloud',
  resend_email:'البريد الإلكتروني',
  zoom_meetings:'Zoom'
};

const PROVIDER_STATES={
  ready:'متصل وجاهز',
  missing_configuration:'بانتظار الإعداد',
  error:'يحتاج مراجعة',
  unknown:'لم يُفحص بعد'
};

const JOB_STATUS={
  pending:'في الطابور',
  processing:'جارٍ التنفيذ',
  sent:'تم بنجاح',
  failed:'تعذر التنفيذ',
  waiting_configuration:'بانتظار الإعداد',
  cancelled:'ملغاة'
};

const JOB_TYPES={
  joining_instructions:'رسالة انضمام',
  session_reminder_24h:'تذكير قبل 24 ساعة',
  session_reminder_1h:'تذكير قبل ساعة',
  zoom_meeting_create:'إنشاء اجتماع Zoom'
};

const CHANNEL_LABELS={
  whatsapp:'واتساب',
  email:'بريد',
  zoom:'Zoom'
};

const MEETING_STATUS={
  not_created:'لم يُنشأ',
  queued:'في طابور الإنشاء',
  ready:'جاهز',
  failed:'تعذر الإنشاء'
};

const AUTOMATION_ERRORS={
  provider_not_configured:'بيانات المزود غير مكتملة',
  whatsapp_not_configured:'بيانات Meta أو القوالب المعتمدة غير مكتملة',
  email_not_configured:'بيانات Resend غير مكتملة',
  zoom_not_configured:'بيانات Zoom Server-to-Server OAuth غير مكتملة',
  dispatcher_timeout:'أُعيدت المهمة بعد انتهاء مهلة المعالجة'
};

const dateTime=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric',
  hour:'2-digit',
  minute:'2-digit'
}):'—';

const percentage=value=>value==null?'—':`${Number(value).toFixed(0)}٪`;

const automationError=value=>{
  if(!value)return '';
  return AUTOMATION_ERRORS[value]||String(value).replaceAll('_',' ');
};

const normalizedPhone=(value,countryCode='966')=>{
  let phone=String(value||'').replace(/\D/g,'');
  if(phone.startsWith('00'))phone=phone.slice(2);
  else if(phone.startsWith('0'))phone=`${countryCode}${phone.slice(1)}`;
  return phone;
};

export default function LearnerOperationsWorkspace({slug,data,automation}){
  const [managedZoom,setManagedZoom]=useState(false);
  const router=useRouter();
  const runs=data?.courseRuns||EMPTY;
  const summary=data?.summary||{};
  const canManage=Boolean(
    data?.viewer?.canManage&&automation?.viewer?.canManage
  );
  const automationSettings=automation?.settings||{};
  const automationJobs=automation?.jobs||EMPTY;
  const meetingBySession=useMemo(
    ()=>new Map(
      (automation?.meetings||EMPTY).map(meeting=>[
        meeting.sessionId,
        meeting
      ])
    ),
    [automation?.meetings]
  );
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
  const [automationDraft,setAutomationDraft]=useState({
    joiningEnabled:true,
    reminder24hEnabled:true,
    reminder1hEnabled:true,
    zoomAutoCreate:false,
    primaryChannel:'whatsapp',
    emailFallbackEnabled:true
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
  const selectedMeeting=selectedSession
    ?meetingBySession.get(selectedSession.id)
    :null;
  const selectedRunJobs=automationJobs.filter(
    job=>job.courseRunId===selectedRun?.id
  );

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

  useEffect(()=>{
    setAutomationDraft({
      joiningEnabled:automationSettings.joiningEnabled??true,
      reminder24hEnabled:automationSettings.reminder24hEnabled??true,
      reminder1hEnabled:automationSettings.reminder1hEnabled??true,
      zoomAutoCreate:automationSettings.zoomAutoCreate??false,
      primaryChannel:automationSettings.primaryChannel||'whatsapp',
      emailFallbackEnabled:
        automationSettings.emailFallbackEnabled??true
    });
  },[
    automationSettings.joiningEnabled,
    automationSettings.reminder24hEnabled,
    automationSettings.reminder1hEnabled,
    automationSettings.zoomAutoCreate,
    automationSettings.primaryChannel,
    automationSettings.emailFallbackEnabled
  ]);

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

  async function automationCall(action,payload,successText,key){
    setBusyKey(key);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/training-automation',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_action:action,
          p_payload:payload||{}
        })
      });
      const responsePayload=await response.json();
      if(!response.ok){
        throw new Error(
          responsePayload.error||'تعذر تنفيذ إجراء الأتمتة'
        );
      }
      setNotice(successText);
      router.refresh();
      return responsePayload.data;
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
    return automationCall(
      'mark_manual_sent',
      {enrollmentId:learner.enrollmentId},
      `تم توثيق الإرسال اليدوي إلى ${learner.fullName}`,
      `join-manual-${learner.enrollmentId}`
    );
  }

  function queueJoining(learner,channel){
    return automationCall(
      'queue_joining',
      {enrollmentId:learner.enrollmentId,channel},
      `أُضيفت رسالة ${learner.fullName} إلى طابور الإرسال`,
      `join-${channel}-${learner.enrollmentId}`
    );
  }

  function prepareAutomationJobs(){
    return automationCall(
      'prepare_jobs',
      {},
      'تم تجهيز الرسائل والتذكيرات المستحقة دون تكرار',
      'prepare-automation'
    );
  }

  function saveAutomationSettings(){
    return automationCall(
      'save_settings',
      automationDraft,
      'تم حفظ قواعد الرسائل والتذكيرات والاجتماعات',
      'automation-settings'
    );
  }

  function queueZoom(session){
    return automationCall(
      'queue_zoom',
      {sessionId:session.id},
      `أُضيف اجتماع ${session.title} إلى طابور Zoom`,
      `zoom-${session.id}`
    );
  }

  function retryAutomationJob(job){
    return automationCall(
      'retry_job',
      {jobId:job.id},
      `أُعيدت محاولة ${JOB_TYPES[job.type]||'المهمة'}`,
      `retry-${job.id}`
    );
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

    <AutomationOverview
      automation={automation}
      draft={automationDraft}
      canManage={canManage}
      busyKey={busyKey}
      onDraftChange={(key,value)=>setAutomationDraft(current=>({
        ...current,
        [key]:value
      }))}
      onSave={saveAutomationSettings}
      onPrepare={prepareAutomationJobs}
    />

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

      {selectedSession&&<details><summary>المحاضرة عبر Zoom: التجهيز والتشغيل والحضور</summary><p>تُستخدم هذه المحاضرة والمدرب والدفعة نفسها. <Link href={`/tenant/${encodeURIComponent(slug)}/addons/zoom?view=accounts`}>إعداد الحسابات والمضيفين</Link></p><ZoomWorkspace slug={slug} sessionId={selectedSession.id} compact onEnabledChange={setManagedZoom}/></details>}

      {selectedSession&&zoomLegacyMeetingVisible(selectedMeeting,automation?.meetings,managedZoom)&&<SessionMeeting
        session={selectedSession}
        meeting={selectedMeeting}
        canManage={canManage}
        busy={busyKey===`zoom-${selectedSession.id}`}
        onQueue={()=>queueZoom(selectedSession)}
      />}

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
          joiningJob={automationJobs.find(job=>
            job.enrollmentId===learner.enrollmentId
            &&job.type==='joining_instructions'
          )}
          countryCode={
            automationSettings.whatsappCountryCode||'966'
          }
          onScoreChange={value=>setScoreDrafts(current=>({
            ...current,
            [learner.enrollmentId]:value
          }))}
          onLateChange={value=>setLateDrafts(current=>({
            ...current,
            [learner.enrollmentId]:value
          }))}
          onCopy={()=>copyJoiningMessage(learner)}
          onQueueJoining={channel=>queueJoining(learner,channel)}
          onMarkJoining={()=>markJoiningSent(learner)}
          onRetryJoining={job=>retryAutomationJob(job)}
          onAttendance={status=>markAttendance(learner,status)}
          onSaveAssessment={()=>saveAssessment(learner)}
          onIssueCertificate={()=>issueCertificate(learner)}
        />)}
        {!(selectedRun.learners||EMPTY).length&&<div className="mt-empty">
          لا يوجد متدربون في هذه الدفعة بعد.
        </div>}
      </div>

      <AutomationJobLog
        jobs={selectedRunJobs}
        canManage={canManage}
        busyKey={busyKey}
        onRetry={retryAutomationJob}
      />
    </section>}
  </section>;
}

function AutomationOverview({
  automation,
  draft,
  canManage,
  busyKey,
  onDraftChange,
  onSave,
  onPrepare
}){
  const providers=automation?.providers||EMPTY;
  const summary=automation?.summary||{};

  return <section className="mt-automation-panel">
    <header>
      <div>
        <small>TRAINING AUTOMATION</small>
        <h3>الرسائل والاجتماعات التلقائية</h3>
        <p>
          طابور موثّق يفحص كل خمس دقائق، ولا يعتمد الإرسال إلا بعد
          استجابة المزود.
        </p>
      </div>
      {canManage&&<div className="mt-automation-head-actions">
        <button
          className="soft"
          onClick={onPrepare}
          disabled={busyKey==='prepare-automation'}
        >
          {busyKey==='prepare-automation'
            ?'جارٍ التجهيز…'
            :'تجهيز المستحق الآن'}
        </button>
        <button
          onClick={onSave}
          disabled={busyKey==='automation-settings'}
        >
          {busyKey==='automation-settings'
            ?'جارٍ الحفظ…'
            :'حفظ قواعد الأتمتة'}
        </button>
      </div>}
    </header>

    <div className="mt-provider-grid">
      {[
        ['whatsapp_cloud','قوالب Meta المعتمدة'],
        ['resend_email','إرسال بريدي موثّق'],
        ['zoom_meetings','Server-to-Server OAuth']
      ].map(([key,description])=>{
        const provider=providers.find(item=>item.provider===key);
        const state=provider?.state||'unknown';
        return <article className={`mt-provider-card ${state}`} key={key}>
          <span className="mt-provider-dot"/>
          <div>
            <b>{PROVIDER_LABELS[key]}</b>
            <small>{description}</small>
          </div>
          <strong>{PROVIDER_STATES[state]||state}</strong>
        </article>;
      })}
    </div>

    <div className="mt-automation-config">
      <label>
        <input
          type="checkbox"
          checked={draft.joiningEnabled}
          onChange={event=>onDraftChange(
            'joiningEnabled',
            event.target.checked
          )}
          disabled={!canManage}
        />
        رسالة الانضمام
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.reminder24hEnabled}
          onChange={event=>onDraftChange(
            'reminder24hEnabled',
            event.target.checked
          )}
          disabled={!canManage}
        />
        تذكير قبل 24 ساعة
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.reminder1hEnabled}
          onChange={event=>onDraftChange(
            'reminder1hEnabled',
            event.target.checked
          )}
          disabled={!canManage}
        />
        تذكير قبل ساعة
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.zoomAutoCreate}
          onChange={event=>onDraftChange(
            'zoomAutoCreate',
            event.target.checked
          )}
          disabled={!canManage}
        />
        إنشاء Zoom تلقائيًا للحساب المهيأ سابقًا
      </label>
      <label className="mt-automation-channel">
        القناة الأساسية
        <select
          value={draft.primaryChannel}
          onChange={event=>onDraftChange(
            'primaryChannel',
            event.target.value
          )}
          disabled={!canManage}
        >
          <option value="whatsapp">واتساب</option>
          <option value="email">البريد الإلكتروني</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.emailFallbackEnabled}
          onChange={event=>onDraftChange(
            'emailFallbackEnabled',
            event.target.checked
          )}
          disabled={!canManage}
        />
        البريد عند غياب رقم واتساب
      </label>
    </div>

    <div className="mt-automation-summary">
      <div><span>في الطابور</span><b>{summary.pending||0}</b></div>
      <div className="waiting">
        <span>بانتظار الإعداد</span>
        <b>{summary.waitingConfiguration||0}</b>
      </div>
      <div className="failed">
        <span>تحتاج إعادة محاولة</span>
        <b>{summary.failed||0}</b>
      </div>
      <div className="sent">
        <span>تمت بنجاح</span>
        <b>{summary.sent||0}</b>
      </div>
      <div className="zoom">
        <span>اجتماعات جاهزة</span>
        <b>{summary.zoomReady||0}</b>
      </div>
    </div>
  </section>;
}

function SessionMeeting({session,meeting,canManage,busy,onQueue}){
  const status=meeting?.status||'not_created';
  const eligible=['online','hybrid'].includes(session.deliveryMode)
    &&session.status==='scheduled'
    &&new Date(session.startsAt)>new Date();

  return <section className={`mt-session-meeting ${status}`}>
    <div className="mt-session-meeting-icon">Z</div>
    <div>
      <b>اجتماع Zoom للجلسة</b>
      <small>
        {MEETING_STATUS[status]||status}
        {meeting?.lastError
          ?` · ${automationError(meeting.lastError)}`
          :''}
      </small>
    </div>
    {meeting?.joinUrl&&<a
      href={meeting.joinUrl}
      target="_blank"
      rel="noreferrer"
    >فتح رابط المتدربين</a>}
    {canManage&&eligible&&status!=='ready'&&<button
      onClick={onQueue}
      disabled={busy||status==='queued'}
    >
      {busy?'جارٍ الإضافة…':status==='failed'?'إعادة إنشاء الاجتماع':'إنشاء الاجتماع'}
    </button>}
    {!eligible&&<em>متاح للجلسات القادمة عن بُعد أو الهجينة</em>}
  </section>;
}

function AutomationJobLog({jobs,canManage,busyKey,onRetry}){
  const shown=jobs.slice(0,12);
  return <section className="mt-automation-log">
    <header>
      <div>
        <h4>سجل الرسائل والاجتماعات</h4>
        <small>آخر 12 عملية لهذه الدفعة مع حالة المزود الفعلية</small>
      </div>
      <span>{jobs.length} عملية</span>
    </header>
    <div>
      {shown.map(job=><article key={job.id}>
        <span className={`mt-job-channel ${job.channel}`}>
          {CHANNEL_LABELS[job.channel]||job.channel}
        </span>
        <div>
          <b>{JOB_TYPES[job.type]||job.type}</b>
          <small>
            {job.recipient||'—'} · الاستحقاق {dateTime(job.dueAt)}
          </small>
          {job.lastError&&<em>{automationError(job.lastError)}</em>}
        </div>
        <strong className={job.status}>
          {JOB_STATUS[job.status]||job.status}
        </strong>
        {canManage&&['failed','waiting_configuration','cancelled']
          .includes(job.status)&&<button
            onClick={()=>onRetry(job)}
            disabled={busyKey===`retry-${job.id}`}
          >إعادة المحاولة</button>}
      </article>)}
      {!shown.length&&<div className="mt-empty compact">
        لا توجد عمليات لهذه الدفعة بعد. استخدم «تجهيز المستحق الآن».
      </div>}
    </div>
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
  joiningJob,
  countryCode,
  onScoreChange,
  onLateChange,
  onCopy,
  onQueueJoining,
  onMarkJoining,
  onRetryJoining,
  onAttendance,
  onSaveAssessment,
  onIssueCertificate
}){
  const attendance=selectedSession
    ?learner.attendance?.[selectedSession.id]
    :null;
  const eligibility=learner.eligibility||{};
  const certificate=learner.certificate;
  const joiningSent=learner.joining?.status==='sent'
    ||joiningJob?.status==='sent';
  const phone=normalizedPhone(learner.phone,countryCode);
  const whatsappLink=phone
    ?`https://wa.me/${phone}?text=${
      encodeURIComponent(learner.joiningMessage||'')
    }`
    :null;
  const emailLink=learner.email
    ?`mailto:${encodeURIComponent(learner.email)}?subject=${
      encodeURIComponent('تعليمات الانضمام إلى البرنامج التدريبي')
    }&body=${encodeURIComponent(learner.joiningMessage||'')}`
    :null;
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
          ?`تم إرسالها ${dateTime(
            learner.joining?.sentAt||joiningJob?.processedAt
          )}`
          :joiningJob
            ?`${JOB_STATUS[joiningJob.status]||joiningJob.status} عبر ${
              CHANNEL_LABELS[joiningJob.channel]||joiningJob.channel
            }`
            :'جاهزة للإرسال الآلي أو اليدوي'}</small>
      </div>
      <div>
        <button onClick={onCopy}>نسخ الرسالة</button>
        {canManage&&!joiningSent&&learner.phone&&<button
          className="primary"
          onClick={()=>onQueueJoining('whatsapp')}
          disabled={busyKey===`join-whatsapp-${learner.enrollmentId}`}
        >إرسال آلي واتساب</button>}
        {canManage&&!joiningSent&&learner.email&&<button
          className="primary"
          onClick={()=>onQueueJoining('email')}
          disabled={busyKey===`join-email-${learner.enrollmentId}`}
        >إرسال آلي بريد</button>}
        {!joiningSent&&joiningJob&&['failed','waiting_configuration','cancelled']
          .includes(joiningJob.status)&&<button
            onClick={()=>onRetryJoining(joiningJob)}
            disabled={busyKey===`retry-${joiningJob.id}`}
          >إعادة المحاولة</button>}
        {whatsappLink&&!joiningSent&&<a
          href={whatsappLink}
          target="_blank"
          rel="noreferrer"
        >فتح واتساب يدويًا</a>}
        {emailLink&&!joiningSent&&<a href={emailLink}>
          فتح البريد يدويًا
        </a>}
        {canManage&&!joiningSent&&<button
          className="manual"
          onClick={onMarkJoining}
          disabled={busyKey===`join-manual-${learner.enrollmentId}`}
        >توثيق الإرسال اليدوي</button>}
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
