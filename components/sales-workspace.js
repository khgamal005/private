'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import CustomerHistoryDrawer from './customer-history-drawer';
import SalesFollowupModal,{
  ACTIONS,
  ActionSelect,
  OPEN_STATUSES,
  QualitySelect,
  SalesQualityBadge,
  SalesStatusBadge,
  dateOnly
} from './sales-followup-modal';

const EMPTY=[];

const ACTIVITY={
  call:'مكالمة',
  meeting:'اجتماع',
  whatsapp:'واتساب',
  email:'بريد إلكتروني',
  note:'ملاحظة'
};

const PIPELINE=[
  {key:'new',label:'جديد',statuses:['new','no_answer','busy','follow_up','postponed']},
  {key:'interested',label:'مهتم',statuses:['interested']},
  {key:'very_interested',label:'مهتم جدًا',statuses:['very_interested']},
  {key:'awaiting_payment',label:'بانتظار الدفع',statuses:['awaiting_payment']}
];

const QUICK_FILTERS=[
  ['all','كل العملاء'],
  ['awaiting_payment','بانتظار الدفع'],
  ['payment_submitted','أُرسل للتحقق'],
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

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',
  currency:'SAR',
  maximumFractionDigits:0
}).format((Number(value)||0)/100);

function digits(value){return String(value||'').replace(/\D/g,'')}
function isClosed(value){
  return !OPEN_STATUSES.has(value)
    &&!['payment_submitted','paid'].includes(value);
}
function inputDate(value){
  const date=new Date(value);
  const year=date.getFullYear();
  const month=String(date.getMonth()+1).padStart(2,'0');
  const day=String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}

export default function SalesWorkspace({
  slug,
  initialData,
  focusContactId=''
}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [view,setView]=useState('pipeline');
  const [query,setQuery]=useState('');
  const [quickFilter,setQuickFilter]=useState('all');
  const [datePreset,setDatePreset]=useState('all');
  const [fromDate,setFromDate]=useState('');
  const [toDate,setToDate]=useState('');
  const [modal,setModal]=useState(null);
  const [historyContact,setHistoryContact]=useState(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>setData(initialData),[initialData]);

  useEffect(()=>{
    if(!focusContactId)return;
    const focused=(initialData.contacts||EMPTY).find(
      contact=>contact.id===focusContactId
    );
    if(!focused)return;
    setView('contacts');
    setQuery(focused.phone||focused.name||'');
    setQuickFilter('all');
    setDatePreset('all');
    setFromDate('');
    setToDate('');
  },[focusContactId,initialData]);

  const contacts=data.contacts||EMPTY;
  const activities=data.activities||EMPTY;
  const handoffs=data.registrationHandoffs||EMPTY;
  const staff=data.staff||EMPTY;
  const courses=data.courses||EMPTY;
  const courseRuns=data.courseRuns||EMPTY;
  const summary=data.summary||{};
  const canWrite=Boolean(data.viewer?.canWriteCrm);
  const paymentSubmittedCount=contacts.filter(
    contact=>contact.leadStatus==='payment_submitted'
  ).length;

  const dateBounds=useMemo(()=>({
    start:fromDate?new Date(`${fromDate}T00:00:00`):null,
    end:toDate?new Date(`${toDate}T23:59:59.999`):null
  }),[fromDate,toDate]);

  const shownContacts=useMemo(()=>contacts.filter(contact=>{
    const haystack=`${contact.name||''} ${contact.organizationName||''} ${contact.phone||''} ${contact.interestCourseName||''} ${contact.source||''} ${contact.campaignName||''}`.toLowerCase();
    if(!haystack.includes(query.trim().toLowerCase()))return false;
    const filterMatches=quickFilter==='all'
      ||(quickFilter==='excellent'&&contact.leadQuality==='excellent')
      ||(quickFilter==='unqualified'&&(contact.leadQuality==='unqualified'||contact.leadStatus==='unqualified'))
      ||(quickFilter==='overdue'&&contact.nextActionAt&&new Date(contact.nextActionAt)<new Date())
      ||(quickFilter==='closed'&&isClosed(contact.leadStatus))
      ||contact.leadStatus===quickFilter;
    if(!filterMatches)return false;
    if(!dateBounds.start&&!dateBounds.end)return true;
    if(!contact.nextActionAt)return false;
    const nextAction=new Date(contact.nextActionAt);
    if(dateBounds.start&&nextAction<dateBounds.start)return false;
    if(dateBounds.end&&nextAction>dateBounds.end)return false;
    return true;
  }),[contacts,query,quickFilter,dateBounds]);

  function openModal(type,record=null){
    setError('');
    setMessage('');
    setModal({type,record});
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
    if(['closed','payment_submitted','paid'].includes(value))setView('contacts');
  }

  function chooseDatePreset(value){
    setDatePreset(value);
    if(value==='all'){
      setFromDate('');
      setToDate('');
      return;
    }
    const start=new Date();
    const end=new Date(start);
    if(value==='7days')end.setDate(end.getDate()+6);
    if(value==='month')end.setDate(end.getDate()+29);
    setFromDate(inputDate(start));
    setToDate(inputDate(end));
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
        <span>دفع مؤكد هذا الشهر</span>
        <b>{summary.paidThisMonth||0}</b>
        <small>{paymentSubmittedCount} بلاغ دفع قيد التحقق</small>
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
          <button className={view==='admissions'?'active':''} onClick={()=>setView('admissions')}>بلاغات الدفع</button>
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

      <div className="mt-sales-date-filters">
        <div className="mt-sales-date-copy">
          <b>فترة المتابعة القادمة</b>
          <small>اعرض العملاء حسب موعد الإجراء التالي</small>
        </div>
        <div className="mt-sales-date-presets">
          <button className={datePreset==='today'?'active':''} onClick={()=>chooseDatePreset('today')}>اليوم</button>
          <button className={datePreset==='7days'?'active':''} onClick={()=>chooseDatePreset('7days')}>7 أيام</button>
          <button className={datePreset==='month'?'active':''} onClick={()=>chooseDatePreset('month')}>شهر</button>
        </div>
        <label>من<input type="date" value={fromDate} onChange={event=>{setFromDate(event.target.value);setDatePreset('custom')}}/></label>
        <label>إلى<input type="date" value={toDate} min={fromDate||undefined} onChange={event=>{setToDate(event.target.value);setDatePreset('custom')}}/></label>
        <button className={`mt-sales-date-clear ${datePreset==='all'?'active':''}`} onClick={()=>chooseDatePreset('all')}>كل التواريخ</button>
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
                onHistory={()=>setHistoryContact(contact)}
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
          <td><div className="mt-customer-row-actions">
            <button className="mt-button soft mt-followup-button" onClick={()=>setHistoryContact(contact)}>سجل العميل</button>
            {canWrite&&(
              ['payment_submitted','paid'].includes(contact.leadStatus)
                ?<span className="mt-status warning">مع التسجيل والقبول</span>
                :<button className="mt-button soft mt-followup-button" onClick={()=>openModal('followup',contact)}>تسجيل متابعة</button>
            )}
          </div></td>
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
            {activity.resultStatus&&<SalesStatusBadge value={activity.resultStatus}/>}
            {activity.resultQuality&&<SalesQualityBadge value={activity.resultQuality}/>}
            <small>{when(activity.occurredAt)}</small>
            {activity.nextActionAt&&<small>التالي: {when(activity.nextActionAt)}</small>}
          </div>
        </div>)}
        {!activities.length&&<div className="mt-empty">لم تسجل متابعات بعد.</div>}
      </div>}

      {view==='admissions'&&<div className="mt-table-wrap">
        <div className="mt-inline-callout">
          <div><b>المبيعات ترسل بلاغ الدفع فقط</b><small>التأكيد والمستندات وإنشاء ملف المتدرب تتم داخل قسم التسجيل والقبول.</small></div>
          <a className="mt-button primary" href={`/tenant/${encodeURIComponent(slug)}/admissions`}>فتح التسجيل والقبول</a>
        </div>
        <table className="mt-table">
        <thead><tr><th>المتدرب</th><th>الدورة</th><th>الدفعة / البداية</th><th>المبلغ المبلّغ</th><th>المسند إليه</th><th>حالة المراجعة</th></tr></thead>
        <tbody>{handoffs.map(item=><tr key={item.id}>
          <td><b>{item.contactName}</b><small>بلاغ وارد من المبيعات</small></td>
          <td>{item.courseName}</td>
          <td><b>{item.courseRunName||'لم تحدد الدفعة'}</b><small>{dateOnly(item.preferredStartDate)}</small></td>
          <td><b>{item.amountMinor==null?'لم يسجل المبلغ':money(item.amountMinor)}</b><small>{when(item.paidAt)}</small></td>
          <td>{item.assignedStaffName||'قسم التسجيل والقبول'}</td>
          <td><span className="mt-status warning">{item.status==='pending'?'بانتظار التحقق':item.status==='in_review'?'قيد المراجعة':item.status==='completed'?'مكتمل':item.status}</span></td>
        </tr>)}</tbody>
      </table>{!handoffs.length&&<div className="mt-empty">لا توجد بلاغات دفع مرسلة للتسجيل بعد.</div>}</div>}
    </section>

    {modal?.type==='lead'&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>

      <form
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
      </form>
    </div>}

    {modal?.type==='followup'&&<SalesFollowupModal
      slug={slug}
      contact={modal.record}
      courses={courses}
      courseRuns={courseRuns}
      onClose={closeModal}
      onSaved={followupMessage=>{
        setMessage(followupMessage);
        setModal(null);
        router.refresh();
      }}
    />}

    {historyContact&&<CustomerHistoryDrawer
      slug={slug}
      contact={historyContact}
      onClose={()=>setHistoryContact(null)}
    />}
  </>;
}

function LeadCard({contact,canWrite,onFollowup,onHistory}){
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
    <div className="mt-lead-card-actions">
      <button className="mt-button soft mt-followup-button" onClick={onHistory}>سجل العميل</button>
      {canWrite&&!['payment_submitted','paid'].includes(contact.leadStatus)&&<button className="mt-button primary mt-followup-button" onClick={onFollowup}>تسجيل نتيجة المتابعة</button>}
    </div>
  </article>;
}

function LeadBadges({contact}){
  return <div className="mt-lead-badges">
    <SalesStatusBadge value={contact.leadStatus}/>
    <SalesQualityBadge value={contact.leadQuality}/>
  </div>;
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
