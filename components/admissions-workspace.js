'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import CourseRunsWorkspace from './course-runs-workspace';
import LearnerOperationsWorkspace from './learner-operations-workspace';
import WooCommerceBeneficiaryAdmissions from './woocommerce-beneficiary-admissions';
import AdmissionGovernancePanel,{AdmissionReadiness} from './admission-governance-panel';

const EMPTY=[];

const CASE_STATUS={
  pending:'بانتظار المراجعة',
  in_review:'قيد الاستكمال',
  accepted:'مقبول',
  rejected:'أعيد للمبيعات',
  completed:'مكتمل',
  cancelled:'ملغي'
};

const PAYMENT_STATUS={
  pending_verification:'بانتظار التحقق',
  verified:'دفع مؤكد',
  rejected:'تعذر التحقق',
  refunded:'مسترد'
};

const DOCUMENTS={
  payment_receipt:'إثبات الدفع',
  national_id:'الهوية الوطنية / الإقامة',
  qualification:'المؤهل أو المتطلب',
  personal_photo:'الصورة الشخصية'
};

const DOCUMENT_STATUS={
  pending:'مطلوب',
  received:'تم الاستلام',
  approved:'معتمد',
  rejected:'مرفوض',
  not_required:'غير مطلوب'
};

const FILTERS=[
  ['all','الكل'],
  ['pending_verification','بانتظار التحقق'],
  ['in_review','قيد الاستكمال'],
  ['accepted','مقبول'],
  ['completed','مكتمل'],
  ['rejected','معاد للمبيعات']
];

const money=value=>value==null?'لم يسجل':new Intl.NumberFormat('ar-SA',{
  style:'currency',
  currency:'SAR',
  maximumFractionDigits:0
}).format(Number(value)/100);

const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric',
  hour:'2-digit',
  minute:'2-digit'
}):'—';

const dateOnly=value=>value?new Date(value).toLocaleDateString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric'
}):'غير محدد';

function paymentTone(value){
  return value==='verified'
    ?'success'
    :value==='rejected'
      ?'danger'
      :'warning';
}

export default function AdmissionsWorkspace({slug,initialData}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [view,setView]=useState('cases');
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState(null);
  const [courseId,setCourseId]=useState('');
  const [courseRunId,setCourseRunId]=useState('');
  const [notes,setNotes]=useState('');
  const [reason,setReason]=useState('');
  const [agreedPrice,setAgreedPrice]=useState('');
  const [agreedCurrency,setAgreedCurrency]=useState('SAR');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');

  useEffect(()=>setData(initialData),[initialData]);

  const cases=data.cases||EMPTY;
  const courses=data.courses||EMPTY;
  const courseRuns=data.courseRuns||EMPTY;
  const summary=data.summary||{};
  const canManage=Boolean(data.viewer?.canManage);
  const canViewFinancialDetails=Boolean(data.viewer?.canViewFinancialDetails);
  const canVerifyPayment=Boolean(data.viewer?.canVerifyPayment);
  const governance=data.admissionGovernance;
  const optionalDocumentsPending=useMemo(()=>cases.reduce(
    (total,item)=>total+(item.documents||EMPTY).filter(
      document=>!document.required&&!['approved','not_required'].includes(document.status)
    ).length,
    0
  ),[cases]);

  const shownCases=useMemo(()=>cases.filter(item=>{
    const haystack=`${item.contactName||''} ${item.phone||''} ${item.courseName||''} ${item.paymentReference||''} ${(item.beneficiaries||EMPTY).map(person=>`${person.name} ${person.phone||''}`).join(' ')}`.toLowerCase();
    if(!haystack.includes(query.trim().toLowerCase()))return false;
    if(filter==='all')return true;
    if(filter==='pending_verification'){
      return item.paymentStatus==='pending_verification'
        &&!['completed','cancelled'].includes(item.status);
    }
    if(filter==='rejected')return item.paymentStatus==='rejected'||item.status==='rejected';
    return item.status===filter;
  }),[cases,filter,query]);

  const availableRuns=useMemo(()=>courseRuns.filter(run=>
    (!courseId||run.courseId===courseId)
    &&(run.registrationOpen||run.id===courseRunId||governance?.enabled&&['planning','open','in_progress'].includes(run.status))
  ),[courseRuns,courseId,courseRunId,governance?.enabled]);

  function openCase(item){
    setSelected(item);
    setCourseId(item.courseId||'');
    setCourseRunId(item.courseRunId||'');
    setNotes(item.notes||'');
    setReason(item.paymentRejectionReason||'');
    setAgreedPrice('');setAgreedCurrency(item.currency||'SAR');
    setError('');
    setNotice('');
  }

  function close(){
    if(busy)return;
    setSelected(null);
    setError('');
  }

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

  async function updateCase(action){
    if(!selected)return;
    setBusy(true);
    setError('');
    setNotice('');
    try{
      await call('update-admission',{
        p_tenant_slug:slug,
        p_handoff_id:selected.id,
        p_action:action,
        p_course_id:canManage?courseId||null:null,
        p_course_run_id:canManage?courseRunId||null:null,
        p_notes:canManage?notes||null:null,
        p_reason:reason||null
      });
      setNotice(successMessage(action));
      setSelected(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  async function updateDocument(document,status,required=document.required){
    if(!selected)return;
    if(status==='rejected'&&reason.trim().length<3){
      setError('اكتب سبب الرفض في خانة الملاحظات قبل رفض المستند');
      return;
    }
    setBusy(true);
    setError('');
    try{
      await call('update-admission-document',{
        p_tenant_slug:slug,
        p_handoff_id:selected.id,
        p_document_type:document.type,
        p_status:status,
        p_notes:reason||null,
        p_is_required:Boolean(required)
      });
      setNotice(`تم تحديث ${DOCUMENTS[document.type]||document.type}`);
      setSelected(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  async function governanceAction(action){
    if(!selected)return;
    setBusy(true);setError('');
    try{
      await call('admission-governance',{p_tenant_slug:slug,p_action:action,p_payload:{
        handoffId:selected.id,courseRunId:courseRunId||null,reason,
        ...(action==='set_agreed_price'?{amountMinor:Math.round(Number(agreedPrice)*100),currency:agreedCurrency}:{})
      }});
      setSelected(null);setNotice('تم حفظ القرار وإعادة تقييم متطلبات التسجيل');router.refresh();
    }catch(err){setError(err.message);}finally{setBusy(false);}
  }

  return <main className="mt-admissions-page" dir="rtl">
    <header className="mt-page-head">
      <div>
        <small>REGISTRATION & ADMISSIONS</small>
        <h2>التسجيل والقبول</h2>
        <p>من بلاغ الدفع إلى التحقق والمستندات ثم إنشاء المتدرب وتسكينه في الدفعة.</p>
      </div>
      <div className="mt-page-actions mt-admissions-view-switch">
        <button
          className={`mt-button ${view==='cases'?'primary':'soft'}`}
          onClick={()=>setView('cases')}
        >طلبات التسجيل</button>
        <button
          className={`mt-button ${view==='batches'?'primary':'soft'}`}
          onClick={()=>setView('batches')}
        >الدفعات والجداول</button>
        <button
          className={`mt-button ${view==='operations'?'primary':'soft'}`}
          onClick={()=>setView('operations')}
        >تشغيل المتدربين</button>
      </div>
    </header>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&!selected&&<div className="mt-alert error">{error}</div>}
    {governance&&<AdmissionGovernancePanel key={`${governance.enabled}-${governance.financeBusinessDays}-${governance.placementBusinessDays}`} slug={slug} policy={governance}/>}

    {view==='batches'
      ?<CourseRunsWorkspace slug={slug} data={data}/>
      :view==='operations'
        ?<LearnerOperationsWorkspace
          slug={slug}
          data={data.trainingOperations}
          automation={data.trainingAutomation}
        />
        :<>
    <section className="mt-kpis mt-admissions-kpis">
      <button onClick={()=>setFilter('pending_verification')} className="mt-kpi warning">
        <span>بانتظار تحقق الدفع</span>
        <b>{summary.pendingVerification||0}</b>
        <small>ليست تسجيلات مؤكدة بعد</small>
      </button>
      <button onClick={()=>setFilter('in_review')} className="mt-kpi">
        <span>قيد الاستكمال</span>
        <b>{summary.inReview||0}</b>
        <small>دفع أو مستندات أو دفعة</small>
      </button>
      <button onClick={()=>setFilter('accepted')} className="mt-kpi">
        <span>مقبول</span>
        <b>{summary.accepted||0}</b>
        <small>جاهز للإدراج النهائي</small>
      </button>
      <button onClick={()=>setFilter('completed')} className="mt-kpi success">
        <span>تم التسجيل</span>
        <b>{summary.completed||0}</b>
        <small>أُنشئ ملف متدرب وتسجيل</small>
      </button>
      <button className="mt-kpi">
        <span>مستندات اختيارية</span>
        <b>{optionalDocumentsPending}</b>
        <small>بانتظار المراجعة ولا تمنع التسجيل</small>
      </button>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar mt-admissions-toolbar">
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
          placeholder="ابحث بالاسم أو الجوال أو الدورة أو مرجع الدفع"
        />
      </div>

      <div className="mt-admissions-grid">
        {shownCases.map(item=><AdmissionCard
          key={item.id}
          item={item}
          canManage={canManage}
          canViewFinancialDetails={canViewFinancialDetails}
          timezone={data.timezone}
          onOpen={()=>openCase(item)}
        />)}
        {!shownCases.length&&<div className="mt-empty">
          لا توجد طلبات مطابقة لهذا الاختيار.
        </div>}
      </div>
    </section>

    {selected&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" onClick={close} aria-label="إغلاق"/>
      <section className="mt-modal mt-admission-modal">
        <header>
          <div>
            <small>طلب تسجيل وقبول</small>
            <h3>{selected.contactName}</h3>
          </div>
          <button type="button" onClick={close}>×</button>
        </header>

        <div className="mt-customer-summary">
          <div><span>الجوال</span><b>{selected.phone||'—'}</b></div>
          <div><span>الدفع</span><b>{PAYMENT_STATUS[selected.paymentStatus]||selected.paymentStatus}</b></div>
          {canViewFinancialDetails&&<><div><span>المبلغ</span><b>{money(selected.paymentAmountMinor)}</b></div>
          <div><span>مرجع العملية</span><b>{selected.paymentReference||'غير مسجل'}</b></div></>}
        </div>

        <div className="mt-admission-modal-body">
          <AdmissionReadiness readiness={selected.readiness} timezone={data.timezone}/>
          {selected.paymentSource==='woocommerce'&&<div className="mt-alert">
            WooCommerce #{selected.orderNumber} · تاريخ الدفع: {when(selected.sourcePaidAt)}
            <br/>تاريخ الإرسال للتسجيل: {when(selected.submittedAt)}
            {selected.paymentOnHold&&<p>تغيرت بيانات الدفع في المتجر؛ يلزم مراجعتها قبل التسجيل.</p>}
          </div>}
          {selected.beneficiaries?.length>0&&<WooCommerceBeneficiaryAdmissions key={selected.id} slug={slug} item={selected}
            courseRuns={courseRuns} canManage={canManage} busy={busy} onBusyChange={setBusy}
            onSaved={result=>{setNotice(`تم تسجيل ${result.enrolled} مستفيد · المتبقي ${result.remaining}`);setSelected(null);router.refresh();}}/>}
          <section className="mt-admission-form">
            <h4>بيانات الدورة والدفعة</h4>
            <div className="mt-form">
              <label className="mt-field">الدورة<select
                value={courseId}
                onChange={event=>{
                  setCourseId(event.target.value);
                  setCourseRunId('');
                }}
                disabled={!canManage||selected.paymentSource==='woocommerce'}
              >
                <option value="">اختر الدورة</option>
                {courses.map(course=><option value={course.id} key={course.id}>{course.nameAr}</option>)}
              </select></label>
              <label className="mt-field">الدفعة<select
                value={courseRunId}
                onChange={event=>setCourseRunId(event.target.value)}
                disabled={!canManage||Boolean(selected.beneficiaries?.length)}
              >
                <option value="">{selected.beneficiaries?.length?'تُحدد لكل مستفيد بالأعلى':'لم تحدد بعد'}</option>
                {availableRuns.map(run=><option value={run.id} key={run.id}>
                  {run.title} · {dateOnly(run.startsAt)} · {run.enrolledCount}/{run.capacity||'∞'} · {run.availableSeats??'∞'} متاح
                </option>)}
              </select></label>
              <label className="mt-field wide">ملاحظات التسجيل<textarea
                rows="3"
                value={notes}
                onChange={event=>setNotes(event.target.value)}
                disabled={!canManage}
              /></label>
              <label className="mt-field wide">سبب القرار أو الاستثناء<textarea
                rows="3"
                value={reason}
                onChange={event=>setReason(event.target.value)}
                disabled={!canManage&&!canVerifyPayment&&!governance?.canApproveExceptions&&!governance?.canApproveWaiver}
                placeholder="يصبح إلزاميًا عند الرفض أو الإلغاء"
              /></label>
            </div>
          </section>

          <section className="mt-document-checklist">
            <header><div><h4>قائمة المستندات</h4><small>{governance?.enabled?'المستند المطلوب يمنع التسجيل حتى اعتماده أو توثيق إعفائه':'كل المستندات اختيارية ويمكن إتمام التسجيل بدونها'}</small></div></header>
            {(selected.documents||EMPTY).map(document=><article key={document.id}>
              <div>
                <b>{DOCUMENTS[document.type]||document.type}</b>
                <small>{document.required?'مطلوب':'اختياري'} · {DOCUMENT_STATUS[document.status]||document.status}</small>
              </div>
              {canManage&&<div>
                <button disabled={busy} onClick={()=>updateDocument(document,'received')}>استلم</button>
                <button disabled={busy} onClick={()=>updateDocument(document,'approved')}>اعتمد</button>
                <button disabled={busy||document.required&&governance?.enabled&&(!governance.canApproveExceptions||reason.trim().length<3)} onClick={()=>updateDocument(document,'not_required')}>غير مطلوب</button>
                <button className="danger" disabled={busy} onClick={()=>updateDocument(document,'rejected')}>رفض</button>
                {governance?.enabled&&<button disabled={busy||document.required&&(!governance.canApproveExceptions||reason.trim().length<3)} onClick={()=>updateDocument(document,document.status,!document.required)}>{document.required?'اجعله اختياريًا':'اجعله مطلوبًا'}</button>}
              </div>}
            </article>)}
          </section>

          {governance?.enabled&&selected.status!=='completed'&&<section className="mt-panel">
            <h4>قرارات استكمال التسجيل</h4>
            {canManage&&<button disabled={busy} onClick={()=>governanceAction('reevaluate')}>إعادة تقييم المتطلبات</button>}
            {governance.canApproveExceptions&&selected.readiness?.waitingReason==='late_enrollment_approval_required'&&<button disabled={busy||reason.trim().length<3} onClick={()=>governanceAction('approve_late_enrollment')}>اعتماد التسجيل المتأخر بالسبب المدون</button>}
            {governance.canApproveWaiver&&<button disabled={busy||reason.trim().length<3} onClick={()=>governanceAction('approve_payment_waiver')}>اعتماد إعفاء دورة قصيرة بالسبب المدون</button>}
            {governance.canAgreePrice&&<div className="mt-form"><label className="mt-field">القيمة المتفق عليها<input type="number" min="0" step="0.01" value={agreedPrice} onChange={e=>setAgreedPrice(e.target.value)}/></label>
              <label className="mt-field">العملة<input value={agreedCurrency} maxLength="3" onChange={e=>setAgreedCurrency(e.target.value.toUpperCase())}/></label>
              <button disabled={busy||agreedPrice===''||!Number.isFinite(Number(agreedPrice))||Number(agreedPrice)<0||reason.trim().length<3} onClick={()=>governanceAction('set_agreed_price')}>توثيق الاتفاق المالي</button></div>}
          </section>}

          {selected.enrollment&&!selected.beneficiaries?.length&&<section className="mt-enrollment-success">
            <span>✓</span>
            <div>
              <b>تم إنشاء ملف المتدرب</b>
              <small>رقم المتدرب: {selected.enrollment.studentNumber}</small>
            </div>
          </section>}

          {error&&<div className="mt-alert error">{error}</div>}
        </div>

        {(canManage||canVerifyPayment)&&<footer className="mt-admission-actions">
          {canManage&&<>
          <button disabled={busy} onClick={()=>updateCase('save_details')}>حفظ البيانات</button>
          {selected.status==='pending'&&<button disabled={busy} onClick={()=>updateCase('start_review')}>بدء المراجعة</button>}
          </>}
          {canVerifyPayment&&selected.paymentStatus!=='verified'&&selected.status!=='completed'&&<>
            <button className="primary" disabled={busy} onClick={()=>updateCase('verify_payment')}>تأكيد الدفع</button>
            <button className="danger" disabled={busy} onClick={()=>updateCase('reject_payment')}>رفض وإعادة للمبيعات</button>
          </>}
          {canManage&&!governance?.enabled&&selected.paymentStatus==='verified'&&!['accepted','completed'].includes(selected.originalStatus||selected.status)&&<button className="primary" disabled={busy} onClick={()=>updateCase('accept')}>اعتماد القبول</button>}
          {canManage&&!governance?.enabled&&selected.paymentStatus==='verified'&&selected.status!=='completed'&&!selected.beneficiaries?.length&&<button className="success" disabled={busy||!courseRunId} onClick={()=>updateCase('complete')}>إنشاء المتدرب وإتمام التسجيل</button>}
        </footer>}
      </section>
    </div>}
    </>}
  </main>;
}

function AdmissionCard({item,canManage,canViewFinancialDetails,timezone,onOpen}){
  const documents=item.documents||EMPTY;
  const reviewed=documents.filter(
    document=>['approved','not_required'].includes(document.status)
  ).length;

  return <article className="mt-admission-card">
    <header>
      <div>
        <h3>{item.contactName}</h3>
        <small>{item.phone||'لا يوجد جوال'} · {item.salesOwnerName||'مبيعات'}</small>
      </div>
      <span className={`mt-admission-payment ${paymentTone(item.paymentStatus)}`}>
        {PAYMENT_STATUS[item.paymentStatus]||item.paymentStatus}
      </span>
    </header>
    <dl>
      <div><dt>الدورة</dt><dd>{item.courseName}</dd></div>
      <div><dt>الدفعة</dt><dd>{item.courseRunName||'لم تحدد'}</dd></div>
      {canViewFinancialDetails&&<div><dt>المبلغ</dt><dd>{money(item.paymentAmountMinor)}</dd></div>}
      <div><dt>البلاغ</dt><dd>{when(item.sourcePaidAt||item.paymentReportedAt)}{item.paymentSource==='woocommerce'&&<small>WooCommerce #{item.orderNumber}</small>}</dd></div>
    </dl>
    <AdmissionReadiness readiness={item.readiness} timezone={timezone}/>
    {item.beneficiaries?.length>0&&<div className="mt-student-number">المستفيدون: {item.beneficiaries.filter(person=>person.enrollmentId).length} / {item.beneficiaries.length} مسجل</div>}
    <div className="mt-admission-progress">
      <div><b>المستندات</b><span>{reviewed}/{documents.length}</span></div>
      <progress value={reviewed} max={Math.max(documents.length,1)}/>
      <small>{reviewed} مستند تمت مراجعته · {documents.some(document=>document.required)?'يشمل مستندات مطلوبة':'مستندات اختيارية'} · {CASE_STATUS[item.status]||item.status}</small>
    </div>
    {item.enrollment&&!item.beneficiaries?.length&&<div className="mt-student-number">رقم المتدرب: {item.enrollment.studentNumber}</div>}
    <button className="mt-button primary" onClick={onOpen}>
      {canManage?'مراجعة الطلب':'عرض الطلب'}
    </button>
  </article>;
}

function successMessage(action){
  return ({
    start_review:'تم بدء مراجعة الطلب',
    save_details:'تم حفظ بيانات التسجيل',
    verify_payment:'تم تأكيد الدفع ونقل العميل إلى مدفوع مؤكد',
    reject_payment:'أُعيد العميل إلى المبيعات مع مهمة متابعة دفع',
    accept:'تم اعتماد القبول',
    complete:'تم إنشاء ملف المتدرب وتسجيله في الدفعة',
    cancel:'تم إلغاء الطلب'
  })[action]||'تم تحديث الطلب';
}
