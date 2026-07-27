'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];
const OPEN_STATUSES=new Set([
  'new',
  'no_answer',
  'busy',
  'follow_up',
  'interested',
  'very_interested',
  'awaiting_payment',
  'postponed'
]);

const STATUS={
  new:{label:'جديد',tone:'neutral'},
  no_answer:{label:'لم يرد',tone:'muted'},
  busy:{label:'مشغول',tone:'warning'},
  follow_up:{label:'متابعة لاحقة',tone:'info'},
  interested:{label:'مهتم',tone:'good'},
  very_interested:{label:'مهتم جدًا',tone:'excellent'},
  awaiting_payment:{label:'بانتظار الدفع',tone:'payment'},
  paid:{label:'تم الدفع',tone:'paid'},
  postponed:{label:'مؤجل',tone:'warning'},
  not_interested:{label:'غير مهتم',tone:'closed'},
  unqualified:{label:'غير مؤهل',tone:'closed'},
  wrong_number:{label:'رقم غير صحيح',tone:'closed'},
  duplicate:{label:'مكرر',tone:'closed'},
  cancelled:{label:'ملغي',tone:'closed'}
};

const QUALITY={
  unrated:{label:'غير مقيم',tone:'muted'},
  unqualified:{label:'غير مؤهل',tone:'closed'},
  weak:{label:'ضعيف',tone:'warning'},
  qualified:{label:'مؤهل',tone:'info'},
  good:{label:'جيد',tone:'good'},
  excellent:{label:'ممتاز',tone:'excellent'}
};

const ACTIONS={
  call:'اتصال',
  whatsapp:'واتساب',
  send_details:'إرسال التفاصيل',
  meeting:'اجتماع',
  payment_followup:'متابعة الدفع',
  follow_up:'متابعة عامة'
};

const ACTIVITY={
  call:'مكالمة',
  meeting:'اجتماع',
  whatsapp:'واتساب',
  email:'بريد إلكتروني',
  note:'ملاحظة'
};

const PIPELINE=[
  {key:'new',label:'جديد',statuses:['new']},
  {key:'followup',label:'يحتاج متابعة',statuses:['no_answer','busy','follow_up','postponed']},
  {key:'interested',label:'مهتم',statuses:['interested']},
  {key:'very_interested',label:'مهتم جدًا',statuses:['very_interested']},
  {key:'awaiting_payment',label:'بانتظار الدفع',statuses:['awaiting_payment']},
  {key:'paid',label:'تم الدفع',statuses:['paid']}
];

const QUICK_FILTERS=[
  ['all','كل العملاء'],
  ['awaiting_payment','بانتظار الدفع'],
  ['very_interested','مهتم جدًا'],
  ['excellent','ليد ممتاز'],
  ['unqualified','غير مؤهل'],
  ['overdue','متابعة متأخرة'],
  ['closed','مغلق']
];

const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  hour:'2-digit',
  minute:'2-digit'
}):'لا يوجد';

const dateOnly=value=>value?new Date(value).toLocaleDateString('ar-SA',{
  day:'numeric',
  month:'short',
  year:'numeric'
}):'لم يحدد';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',
  currency:'SAR',
  maximumFractionDigits:0
}).format((Number(value)||0)/100);

function statusMeta(value){return STATUS[value]||{label:value||'غير محدد',tone:'muted'}}
function qualityMeta(value){return QUALITY[value]||QUALITY.unrated}
function digits(value){return String(value||'').replace(/\D/g,'')}
function isClosed(value){return !OPEN_STATUSES.has(value)&&value!=='paid'}

export default function SalesWorkspace({slug,initialData}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [view,setView]=useState('pipeline');
  const [query,setQuery]=useState('');
  const [quickFilter,setQuickFilter]=useState('all');
  const [modal,setModal]=useState(null);
  const [followupStatus,setFollowupStatus]=useState('follow_up');
  const [paidCourseId,setPaidCourseId]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>setData(initialData),[initialData]);

  const contacts=data.contacts||EMPTY;
  const activities=data.activities||EMPTY;
  const handoffs=data.registrationHandoffs||EMPTY;
  const staff=data.staff||EMPTY;
  const courses=data.courses||EMPTY;
  const courseRuns=data.courseRuns||EMPTY;
  const summary=data.summary||{};
  const canWrite=Boolean(data.viewer?.canWriteCrm);

  const shownContacts=useMemo(()=>contacts.filter(contact=>{
    const haystack=`${contact.name||''} ${contact.organizationName||''} ${contact.phone||''} ${contact.interestCourseName||''} ${contact.source||''} ${contact.campaignName||''}`.toLowerCase();
    if(!haystack.includes(query.trim().toLowerCase()))return false;
    if(quickFilter==='all')return true;
    if(quickFilter==='excellent')return contact.leadQuality==='excellent';
    if(quickFilter==='unqualified')return contact.leadQuality==='unqualified'||contact.leadStatus==='unqualified';
    if(quickFilter==='overdue')return contact.nextActionAt&&new Date(contact.nextActionAt)<new Date();
    if(quickFilter==='closed')return isClosed(contact.leadStatus);
    return contact.leadStatus===quickFilter;
  }),[contacts,query,quickFilter]);

  const availableRuns=useMemo(()=>courseRuns.filter(run=>
    !paidCourseId||run.courseId===paidCourseId
  ),[courseRuns,paidCourseId]);

  function openModal(type,record=null){
    setError('');
    setMessage('');
    setModal({type,record});
    if(type==='followup'){
      setFollowupStatus(OPEN_STATUSES.has(record?.leadStatus)?record.leadStatus:'follow_up');
      setPaidCourseId(record?.interestCourseId||'');
    }
  }

  function closeModal(){
    if(busy)return;
    setModal(null);
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

  async function submit(event,action,buildBody,successMessage){
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try{
      const result=await call(
        action,
        buildBody(Object.fromEntries(new FormData(event.currentTarget).entries()))
      );
      setMessage(typeof successMessage==='function'?successMessage(result):successMessage);
      setModal(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  function activateFilter(value){
    setQuickFilter(value);
    if(value==='closed')setView('contacts');
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>LEAD-CENTRIC SALES FLOW</small>
        <h2>مسار المبيعات والمتابعات</h2>
        <p>العميل هو محور المسار: كل نتيجة تحدد حالته وجودته والإجراء التالي تلقائيًا.</p>
      </div>
      {canWrite&&<div className="mt-page-actions">
        <button className="mt-button primary" onClick={()=>openModal('lead')}>+ إضافة عميل</button>
      </div>}
    </header>

    {contacts.some(item=>item.demo)&&<section className="mt-data-note warning">
      <div>
        <b>بيانات ريف التشغيلية الحالية تجريبية</b>
        <p>توضح الحالات وجودة الليد والتسليم للتسجيل، وكل سجل مميز داخل قاعدة البيانات.</p>
      </div>
      <span>DEMO</span>
    </section>}

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis mt-sales-kpis">
      <button className="mt-kpi" onClick={()=>activateFilter('awaiting_payment')}>
        <span>بانتظار الدفع</span>
        <b>{summary.awaitingPayment||0}</b>
        <small>أقرب العملاء للتحويل</small>
      </button>
      <button className="mt-kpi" onClick={()=>activateFilter('very_interested')}>
        <span>مهتم جدًا</span>
        <b>{summary.veryInterested||0}</b>
        <small>يحتاجون متابعة دقيقة</small>
      </button>
      <button className="mt-kpi" onClick={()=>activateFilter('excellent')}>
        <span>ليدز ممتازة</span>
        <b>{summary.excellentLeads||0}</b>
        <small>أفضل جودة حاليًا</small>
      </button>
      <button className="mt-kpi" onClick={()=>activateFilter('paid')}>
        <span>تم الدفع هذا الشهر</span>
        <b>{summary.paidThisMonth||0}</b>
        <small>{handoffs.length} تنويه تسجيل ظاهر</small>
      </button>
      <button className={`mt-kpi ${summary.overdueFollowups?'danger':''}`} onClick={()=>activateFilter('overdue')}>
        <span>متابعات متأخرة</span>
        <b>{summary.overdueFollowups||0}</b>
        <small>تحتاج إجراءً الآن</small>
      </button>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar mt-sales-toolbar">
        <div className="mt-segmented">
          <button className={view==='pipeline'?'active':''} onClick={()=>setView('pipeline')}>المسار العملي</button>
          <button className={view==='contacts'?'active':''} onClick={()=>setView('contacts')}>كل العملاء</button>
          <button className={view==='activities'?'active':''} onClick={()=>setView('activities')}>سجل المتابعات</button>
          <button className={view==='admissions'?'active':''} onClick={()=>setView('admissions')}>التسجيل والقبول</button>
        </div>
        <input
          className="mt-search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث بالاسم أو الجوال أو الدورة أو الحملة"
        />
      </div>

      <div className="mt-lead-quick-filters">
        {QUICK_FILTERS.map(([key,label])=><button
          key={key}
          className={quickFilter===key?'active':''}
          onClick={()=>activateFilter(key)}
        >{label}</button>)}
      </div>

      {view==='pipeline'&&<div className="mt-lead-board">
        {PIPELINE.map(group=>{
          const items=shownContacts.filter(contact=>group.statuses.includes(contact.leadStatus));
          return <section className={`mt-lead-column status-${group.key}`} key={group.key}>
            <header>
              <div><b>{group.label}</b><small>{items.length} عميل</small></div>
              <span>{items.length}</span>
            </header>
            <div>
              {items.map(contact=><LeadCard
                key={contact.id}
                contact={contact}
                canWrite={canWrite}
                onFollowup={()=>openModal('followup',contact)}
              />)}
              {!items.length&&<div className="mt-column-empty">لا يوجد عملاء</div>}
            </div>
          </section>;
        })}
      </div>}

      {view==='contacts'&&<div className="mt-table-wrap"><table className="mt-table mt-leads-table">
        <thead><tr><th>العميل</th><th>الحالة والجودة</th><th>الدورة</th><th>المصدر والحملة</th><th>المسؤول</th><th>الإجراء التالي</th><th>إجراء</th></tr></thead>
        <tbody>{shownContacts.map(contact=><tr key={contact.id}>
          <td><b>{contact.name}</b><small>{contact.phone||'لا يوجد جوال'}</small></td>
          <td><LeadBadges contact={contact}/></td>
          <td><b>{contact.interestCourseName||'لم تحدد'}</b><small>{contact.organizationName||'عميل فردي'}</small></td>
          <td><b>{contact.source||'غير محدد'}</b><small>{contact.campaignName||contact.adName||'لا توجد حملة'}</small></td>
          <td>{contact.ownerName||'غير مسند'}</td>
          <td><b>{contact.nextActionType?ACTIONS[contact.nextActionType]||contact.nextActionType:'لا توجد متابعة'}</b><small>{when(contact.nextActionAt)}</small></td>
          <td>{canWrite&&<button className="mt-button soft" onClick={()=>openModal('followup',contact)}>تسجيل متابعة</button>}</td>
        </tr>)}</tbody>
      </table>{!shownContacts.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}</div>}

      {view==='activities'&&<div className="mt-panel-body mt-list">
        {activities.filter(activity=>
          !query||`${activity.contactName} ${activity.contactPhone} ${activity.summary}`.toLowerCase().includes(query.toLowerCase())
        ).map(activity=><div className="mt-list-row mt-activity-row" key={activity.id}>
          <div>
            <b>{ACTIVITY[activity.type]||activity.type} · {activity.contactName}</b>
            <small>{activity.summary} · {activity.actorName||'إدارة المنشأة'}</small>
          </div>
          <div className="mt-activity-result">
            {activity.resultStatus&&<StatusBadge value={activity.resultStatus}/>}
            {activity.resultQuality&&<QualityBadge value={activity.resultQuality}/>}
            <small>{when(activity.occurredAt)}</small>
            {activity.nextActionAt&&<small>التالي: {when(activity.nextActionAt)}</small>}
          </div>
        </div>)}
        {!activities.length&&<div className="mt-empty">لم تسجل متابعات بعد.</div>}
      </div>}

      {view==='admissions'&&<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>المتدرب</th><th>الدورة</th><th>الدفعة / البداية</th><th>الدفع</th><th>المسند إليه</th><th>حالة التسجيل</th></tr></thead>
        <tbody>{handoffs.map(item=><tr key={item.id}>
          <td><b>{item.contactName}</b><small>تم التسليم من المبيعات</small></td>
          <td>{item.courseName}</td>
          <td><b>{item.courseRunName||'لم تحدد الدفعة'}</b><small>{dateOnly(item.preferredStartDate)}</small></td>
          <td><b>{item.amountMinor==null?'لم يسجل المبلغ':money(item.amountMinor)}</b><small>{when(item.paidAt)}</small></td>
          <td>{item.assignedStaffName||'قسم التسجيل والقبول'}</td>
          <td><span className="mt-status warning">{item.status==='pending'?'بانتظار الاستكمال':item.status}</span></td>
        </tr>)}</tbody>
      </table>{!handoffs.length&&<div className="mt-empty">لم تُسلّم أي حالات مدفوعة للتسجيل بعد.</div>}</div>}
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>

      {modal.type==='lead'&&<form
        className="mt-modal"
        onSubmit={event=>submit(
          event,
          'create-sales-lead',
          values=>({
            p_tenant_slug:slug,
            p_full_name:values.full_name,
            p_phone:values.phone||null,
            p_whatsapp:values.whatsapp||null,
            p_email:values.email||null,
            p_organization_name:values.organization_name||null,
            p_source:values.source||'manual',
            p_campaign_name:values.campaign_name||null,
            p_ad_name:values.ad_name||null,
            p_owner_staff_id:values.owner_staff_id||null,
            p_interest_course_id:values.interest_course_id||null,
            p_lead_quality:values.lead_quality||'unrated',
            p_next_action_type:values.next_action_type,
            p_next_action_at:new Date(values.next_action_at).toISOString(),
            p_notes:values.notes||null
          }),
          'تمت إضافة العميل وإنشاء أول مهمة متابعة في التقويم'
        )}
      >
        <ModalHeader title="إضافة عميل وبدء المتابعة" onClose={closeModal}/>
        <div className="mt-form">
          <label className="mt-field">اسم العميل<input name="full_name" required/></label>
          <label className="mt-field">رقم الجوال<input name="phone" required/></label>
          <label className="mt-field">رقم واتساب<input name="whatsapp"/></label>
          <label className="mt-field">الجهة<input name="organization_name"/></label>
          <label className="mt-field">البريد<input name="email" type="email"/></label>
          <label className="mt-field">جودة الليد<QualitySelect name="lead_quality"/></label>
          <label className="mt-field">المصدر<select name="source"><option value="manual">إدخال يدوي</option><option value="meta">Meta</option><option value="google">Google</option><option value="tiktok">TikTok</option><option value="snapchat">Snapchat</option><option value="website">الموقع</option><option value="whatsapp">واتساب</option><option value="referral">ترشيح</option></select></label>
          <label className="mt-field">اسم الحملة<input name="campaign_name"/></label>
          <label className="mt-field">اسم الإعلان<input name="ad_name"/></label>
          <label className="mt-field">الدورة<select name="interest_course_id"><option value="">غير محددة</option>{courses.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">مسؤول المتابعة<select name="owner_staff_id"><option value="">أنا / غير مسند</option>{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">أول إجراء<ActionSelect name="next_action_type"/></label>
          <label className="mt-field">موعد الإجراء<input name="next_action_at" type="datetime-local" required/></label>
          <label className="mt-field wide">ملاحظات<textarea name="notes" rows="3"/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <ModalFooter busy={busy} onClose={closeModal} label="حفظ وبدء المتابعة"/>
      </form>}

      {modal.type==='followup'&&<form
        className="mt-modal"
        onSubmit={event=>submit(
          event,
          'record-sales-followup',
          values=>{
            const open=OPEN_STATUSES.has(values.lead_status);
            const paid=values.lead_status==='paid';
            return {
              p_tenant_slug:slug,
              p_contact_id:modal.record.id,
              p_activity_type:values.activity_type,
              p_summary:values.summary,
              p_lead_status:values.lead_status,
              p_lead_quality:values.lead_quality,
              p_next_action_type:open?values.next_action_type:null,
              p_next_action_at:open?new Date(values.next_action_at).toISOString():null,
              p_course_id:paid?(values.course_id||null):(modal.record.interestCourseId||null),
              p_course_run_id:paid?(values.course_run_id||null):null,
              p_payment_amount_minor:paid&&values.payment_amount?Math.round(Number(values.payment_amount)*100):null,
              p_payment_reference:paid?(values.payment_reference||null):null,
              p_preferred_start_date:paid?(values.preferred_start_date||null):null
            };
          },
          result=>result.registrationNotified
            ?'تم حفظ المتابعة وإرسال تنويه مباشر إلى التسجيل والقبول'
            :'تم حفظ النتيجة وإنشاء مهمة الإجراء التالي تلقائيًا'
        )}
      >
        <ModalHeader title={`نتيجة المتابعة · ${modal.record.name}`} onClose={closeModal}/>
        <div className="mt-customer-summary">
          <div><span>الجوال</span><b>{modal.record.phone||'—'}</b></div>
          <div><span>الحالة الحالية</span><StatusBadge value={modal.record.leadStatus}/></div>
          <div><span>الجودة الحالية</span><QualityBadge value={modal.record.leadQuality}/></div>
          <div><span>الدورة</span><b>{modal.record.interestCourseName||'لم تحدد'}</b></div>
        </div>
        <div className="mt-form">
          <label className="mt-field">وسيلة التواصل<select name="activity_type"><option value="call">مكالمة</option><option value="whatsapp">واتساب</option><option value="meeting">اجتماع</option><option value="email">بريد إلكتروني</option><option value="note">ملاحظة</option></select></label>
          <label className="mt-field">حالة العميل<StatusSelect name="lead_status" value={followupStatus} onChange={event=>setFollowupStatus(event.target.value)}/></label>
          <label className="mt-field">جودة الليد<QualitySelect name="lead_quality" defaultValue={modal.record.leadQuality}/></label>
          <label className="mt-field wide">ما الذي حدث؟<textarea name="summary" rows="4" required placeholder="اكتب ملخصًا واضحًا لنتيجة التواصل"/></label>

          {OPEN_STATUSES.has(followupStatus)&&<>
            <label className="mt-field">الإجراء التالي<ActionSelect name="next_action_type" preferred={followupStatus==='awaiting_payment'?'payment_followup':'follow_up'}/></label>
            <label className="mt-field">موعد الإجراء التالي<input name="next_action_at" type="datetime-local" required/></label>
          </>}

          {followupStatus==='paid'&&<>
            <div className="mt-form-section wide"><b>تسليم إلى التسجيل والقبول</b><small>الدفعة وتاريخ البداية اختياريان ويمكن استكمالهما لاحقًا.</small></div>
            <label className="mt-field">الدورة<select name="course_id" value={paidCourseId} onChange={event=>setPaidCourseId(event.target.value)} required><option value="">اختر الدورة</option>{courses.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
            <label className="mt-field">الدفعة<select name="course_run_id"><option value="">لم تحدد الدفعة بعد</option>{availableRuns.map(item=><option value={item.id} key={item.id}>{item.title} · {dateOnly(item.startsAt)}</option>)}</select></label>
            <label className="mt-field">المبلغ المدفوع<input name="payment_amount" type="number" min="0" step=".01"/></label>
            <label className="mt-field">مرجع الدفع<input name="payment_reference"/></label>
            <label className="mt-field">بداية مفضلة<input name="preferred_start_date" type="date"/></label>
          </>}

          {!OPEN_STATUSES.has(followupStatus)&&followupStatus!=='paid'&&<div className="mt-form-section wide closed">
            <b>سيتم إغلاق المتابعة البيعية</b>
            <small>لن تُنشأ مهمة جديدة، وستظل النتيجة محفوظة في سجل العميل والتقارير.</small>
          </div>}

          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <ModalFooter busy={busy} onClose={closeModal} label={followupStatus==='paid'?'حفظ وإرسال للتسجيل':'حفظ النتيجة'}/>
      </form>}
    </div>}
  </>;
}

function LeadCard({contact,canWrite,onFollowup}){
  return <article className="mt-lead-card">
    <header>
      <div><h3>{contact.name}</h3><small>{contact.interestCourseName||'الدورة غير محددة'}</small></div>
      {contact.demo&&<em>تجريبي</em>}
    </header>
    <div className="mt-lead-contact">
      {contact.phone?<a href={`tel:${digits(contact.phone)}`}>{contact.phone}</a>:<span>لا يوجد جوال</span>}
      {(contact.whatsapp||contact.phone)&&<a target="_blank" rel="noreferrer" href={`https://wa.me/${digits(contact.whatsapp||contact.phone)}`}>واتساب</a>}
    </div>
    <LeadBadges contact={contact}/>
    <dl>
      <div><dt>المسؤول</dt><dd>{contact.ownerName||'غير مسند'}</dd></div>
      <div><dt>المصدر</dt><dd>{contact.source||'غير محدد'}</dd></div>
      <div className="wide"><dt>الإجراء التالي</dt><dd>{contact.nextActionType?`${ACTIONS[contact.nextActionType]||contact.nextActionType} · ${when(contact.nextActionAt)}`:'تم إنهاء المتابعة البيعية'}</dd></div>
    </dl>
    {canWrite&&<button className="mt-button primary wide" onClick={onFollowup}>تسجيل نتيجة المتابعة</button>}
  </article>;
}

function LeadBadges({contact}){
  return <div className="mt-lead-badges">
    <StatusBadge value={contact.leadStatus}/>
    <QualityBadge value={contact.leadQuality}/>
  </div>;
}

function StatusBadge({value}){
  const meta=statusMeta(value);
  return <span className={`mt-lead-badge ${meta.tone}`}>{meta.label}</span>;
}

function QualityBadge({value}){
  const meta=qualityMeta(value);
  return <span className={`mt-quality-badge ${meta.tone}`}>{meta.label}</span>;
}

function StatusSelect(props){
  return <select {...props}>
    {Object.entries(STATUS).map(([key,item])=><option value={key} key={key}>{item.label}</option>)}
  </select>;
}

function QualitySelect({defaultValue='unrated',...props}){
  return <select defaultValue={defaultValue||'unrated'} {...props}>
    {Object.entries(QUALITY).map(([key,item])=><option value={key} key={key}>{item.label}</option>)}
  </select>;
}

function ActionSelect({preferred='call',...props}){
  return <select defaultValue={preferred} {...props}>
    {Object.entries(ACTIONS).map(([key,label])=><option value={key} key={key}>{label}</option>)}
  </select>;
}

function ModalHeader({title,onClose}){
  return <header><h3>{title}</h3><button type="button" onClick={onClose}>×</button></header>;
}

function ModalFooter({busy,onClose,label}){
  return <footer>
    <button type="button" className="mt-button" onClick={onClose}>إلغاء</button>
    <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':label}</button>
  </footer>;
}
