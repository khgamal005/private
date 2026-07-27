'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',
  currency:'SAR',
  maximumFractionDigits:0
}).format((Number(value)||0)/100);

const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',
  month:'short',
  hour:'2-digit',
  minute:'2-digit'
}):'غير محدد';

const activityLabels={
  call:'مكالمة',
  meeting:'اجتماع',
  whatsapp:'واتساب',
  email:'بريد إلكتروني',
  offer:'إرسال عرض',
  note:'ملاحظة'
};
const EMPTY=[];

export default function SalesWorkspace({slug,initialData}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [view,setView]=useState('pipeline');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>setData(initialData),[initialData]);

  const contacts=data.contacts||EMPTY;
  const opportunities=data.opportunities||EMPTY;
  const activities=data.activities||EMPTY;
  const stages=data.stages||EMPTY;
  const openStages=stages.filter(stage=>!stage.closed);
  const staff=data.staff||EMPTY;
  const courses=data.courses||EMPTY;
  const summary=data.summary||{};
  const canWrite=Boolean(data.viewer?.canWriteCrm);

  const shownContacts=useMemo(()=>contacts.filter(contact=>
    `${contact.name||''} ${contact.organizationName||''} ${contact.phone||''} ${contact.interestCourseName||''}`
      .toLowerCase()
      .includes(query.toLowerCase())
  ),[contacts,query]);

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

  async function submit(event,action,body,messageText){
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try{
      await call(action,body(Object.fromEntries(new FormData(event.currentTarget).entries())));
      setMessage(messageText);
      setModal(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  async function moveOpportunity(id,stageId){
    const previous=data;
    setData({
      ...data,
      opportunities:opportunities.map(item=>
        item.id===id?{...item,stageId}:item
      )
    });
    setError('');
    try{
      await call('move-opportunity',{
        p_tenant_slug:slug,
        p_opportunity_id:id,
        p_stage_id:stageId
      });
      setMessage('تم تحديث مرحلة الفرصة');
      router.refresh();
    }catch(err){
      setData(previous);
      setError(err.message);
    }
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>SALES DAILY OPERATIONS</small>
        <h2>المبيعات والعملاء والفرص</h2>
        <p>كل تواصل ينتج عنه إجراء تالٍ ومهمة واضحة حتى الإغلاق.</p>
      </div>
      {canWrite&&<div className="mt-page-actions">
        <button className="mt-button" onClick={()=>openModal('contact')}>+ عميل جديد</button>
        <button className="mt-button primary" onClick={()=>openModal('opportunity')}>+ فرصة جديدة</button>
      </div>}
    </header>

    {contacts.some(item=>item.demo)&&<section className="mt-data-note warning">
      <div>
        <b>بيانات ريف التشغيلية الحالية تجريبية</b>
        <p>الأسماء والأرقام مخصصة للمعاينة، وكل سجل يحمل علامة تجريبية داخل قاعدة البيانات.</p>
      </div>
      <span>DEMO</span>
    </section>}

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis">
      <article className="mt-kpi">
        <span>قيمة الفرص المفتوحة</span>
        <b>{money(summary.pipelineValueMinor)}</b>
        <small>{summary.openOpportunities||0} فرصة</small>
      </article>
      <article className="mt-kpi">
        <span>العملاء النشطون</span>
        <b>{summary.activeContacts||0}</b>
        <small>{contacts.length} سجل ظاهر لصلاحيتك</small>
      </article>
      <article className="mt-kpi">
        <span>أنشطة اليوم</span>
        <b>{summary.activitiesToday||0}</b>
        <small>مكالمات واجتماعات ومتابعات</small>
      </article>
      <article className="mt-kpi">
        <span>ناجحة هذا الشهر</span>
        <b>{summary.wonThisMonth||0}</b>
        <small>فرص أغلقت بنجاح</small>
      </article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={view==='pipeline'?'active':''} onClick={()=>setView('pipeline')}>مسار الفرص</button>
          <button className={view==='contacts'?'active':''} onClick={()=>setView('contacts')}>العملاء</button>
          <button className={view==='activities'?'active':''} onClick={()=>setView('activities')}>الأنشطة</button>
        </div>
        {view==='contacts'&&<input
          className="mt-search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث بالاسم أو الجوال أو الدورة"
        />}
      </div>

      {view==='pipeline'&&<div className="mt-sales-board">
        {openStages.map(stage=>{
          const items=opportunities.filter(item=>
            item.stageId===stage.id&&item.status==='open'
          );
          return <section className="mt-sales-column" key={stage.id}>
            <header>
              <div>
                <b>{stage.nameAr}</b>
                <small>{money(items.reduce((sum,item)=>sum+Number(item.valueMinor||0),0))}</small>
              </div>
              <span>{items.length}</span>
            </header>
            <div>
              {items.map(item=><article className="mt-opportunity-card" key={item.id}>
                <small>{item.courseName||'خدمة عامة'} {item.demo&&<em>· تجريبي</em>}</small>
                <h3>{item.title}</h3>
                <p>{item.organizationName||item.contactName}</p>
                <strong>{money(item.valueMinor)}</strong>
                <dl>
                  <div><dt>المسؤول</dt><dd>{item.ownerName||'غير مسند'}</dd></div>
                  <div><dt>الإجراء التالي</dt><dd>{when(item.nextActionAt)}</dd></div>
                </dl>
                <div className="mt-card-actions">
                  {canWrite&&<button
                    className="mt-button soft"
                    onClick={()=>openModal('activity',item)}
                  >+ نشاط</button>}
                  <select
                    value={item.stageId}
                    disabled={!canWrite||busy}
                    onChange={event=>moveOpportunity(item.id,event.target.value)}
                  >
                    {stages.map(option=><option value={option.id} key={option.id}>{option.nameAr}</option>)}
                  </select>
                </div>
              </article>)}
              {!items.length&&<div className="mt-column-empty">لا توجد فرص</div>}
            </div>
          </section>;
        })}
      </div>}

      {view==='contacts'&&<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>العميل</th><th>الجهة / الدورة</th><th>التواصل</th><th>المسؤول</th><th>الإجراء</th></tr></thead>
        <tbody>{shownContacts.map(contact=><tr key={contact.id}>
          <td>
            <b>{contact.name}</b>
            <small>{contact.demo?'بيانات تجريبية':contact.source}</small>
          </td>
          <td>
            <b>{contact.organizationName||'فرد'}</b>
            <small>{contact.interestCourseName||'لم تحدد الدورة'}</small>
          </td>
          <td><b>{contact.phone||'—'}</b><small>{contact.email||'لا يوجد بريد'}</small></td>
          <td>{contact.ownerName||'غير مسند'}</td>
          <td>{canWrite&&<button className="mt-button soft" onClick={()=>openModal('opportunity',contact)}>+ فرصة</button>}</td>
        </tr>)}</tbody>
      </table>{!shownContacts.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}</div>}

      {view==='activities'&&<div className="mt-panel-body mt-list">
        {activities.map(activity=><div className="mt-list-row" key={activity.id}>
          <div>
            <b>{activityLabels[activity.type]||activity.type} · {activity.contactName}</b>
            <small>{activity.summary} · {activity.actorName||'إدارة المنشأة'}</small>
          </div>
          <div>
            <span className="mt-status">{when(activity.occurredAt)}</span>
            {activity.nextActionAt&&<small>التالي: {when(activity.nextActionAt)}</small>}
          </div>
        </div>)}
        {!activities.length&&<div className="mt-empty">لم تسجل أنشطة بعد.</div>}
      </div>}
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>

      {modal.type==='contact'&&<form
        className="mt-modal"
        onSubmit={event=>submit(
          event,
          'create-contact',
          values=>({
            p_tenant_slug:slug,
            p_full_name:values.full_name,
            p_phone:values.phone||null,
            p_whatsapp:values.whatsapp||null,
            p_email:values.email||null,
            p_organization_name:values.organization_name||null,
            p_source:values.source||'manual',
            p_owner_staff_id:values.owner_staff_id||null,
            p_interest_course_id:values.interest_course_id||null,
            p_notes:values.notes||null
          }),
          'تم إنشاء العميل وإسناده للمسؤول'
        )}
      >
        <ModalHeader title="إضافة عميل جديد" onClose={closeModal}/>
        <div className="mt-form">
          <label className="mt-field">اسم العميل<input name="full_name" required/></label>
          <label className="mt-field">الجهة<input name="organization_name"/></label>
          <label className="mt-field">الجوال<input name="phone"/></label>
          <label className="mt-field">واتساب<input name="whatsapp"/></label>
          <label className="mt-field">البريد<input name="email" type="email"/></label>
          <label className="mt-field">المصدر<select name="source"><option value="manual">إدخال يدوي</option><option value="meta">Meta</option><option value="google">Google</option><option value="website">الموقع</option><option value="whatsapp">واتساب</option><option value="referral">ترشيح</option></select></label>
          <label className="mt-field">الدورة<select name="interest_course_id"><option value="">غير محددة</option>{courses.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">مسؤول المتابعة<select name="owner_staff_id"><option value="">غير مسند</option>{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field wide">ملاحظات<textarea name="notes" rows="3"/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <ModalFooter busy={busy} onClose={closeModal} label="حفظ العميل"/>
      </form>}

      {modal.type==='opportunity'&&<form
        className="mt-modal"
        onSubmit={event=>submit(
          event,
          'create-opportunity',
          values=>({
            p_tenant_slug:slug,
            p_contact_id:values.contact_id,
            p_title:values.title,
            p_stage_id:values.stage_id,
            p_value_minor:Math.round(Number(values.value||0)*100),
            p_course_id:values.course_id||null,
            p_owner_staff_id:values.owner_staff_id||null,
            p_expected_close_date:values.expected_close_date||null,
            p_next_action_type:values.next_action_type,
            p_next_action_at:new Date(values.next_action_at).toISOString()
          }),
          'تم إنشاء الفرصة ومهمة الإجراء التالي'
        )}
      >
        <ModalHeader title="إنشاء فرصة مبيعات" onClose={closeModal}/>
        <div className="mt-form">
          <label className="mt-field">العميل<select name="contact_id" defaultValue={modal.record?.id||''} required><option value="">اختر العميل</option>{contacts.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">عنوان الفرصة<input name="title" required/></label>
          <label className="mt-field">المرحلة<select name="stage_id" required><option value="">اختر المرحلة</option>{openStages.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">الدورة<select name="course_id" defaultValue={modal.record?.interestCourseId||''}><option value="">غير محددة</option>{courses.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">المسؤول<select name="owner_staff_id" defaultValue={modal.record?.ownerStaffId||''}><option value="">حسب العميل</option>{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">القيمة بالريال<input name="value" type="number" min="0" step=".01"/></label>
          <label className="mt-field">الإغلاق المتوقع<input name="expected_close_date" type="date"/></label>
          <label className="mt-field">الإجراء التالي<select name="next_action_type" required><option value="call">مكالمة</option><option value="meeting">اجتماع</option><option value="whatsapp">واتساب</option><option value="offer">إرسال عرض</option><option value="follow_up">متابعة</option></select></label>
          <label className="mt-field">موعد الإجراء<input name="next_action_at" type="datetime-local" required/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <ModalFooter busy={busy} onClose={closeModal} label="حفظ الفرصة"/>
      </form>}

      {modal.type==='activity'&&<form
        className="mt-modal"
        onSubmit={event=>submit(
          event,
          'log-activity',
          values=>({
            p_tenant_slug:slug,
            p_opportunity_id:modal.record.id,
            p_activity_type:values.activity_type,
            p_summary:values.summary,
            p_outcome:values.outcome||null,
            p_occurred_at:new Date().toISOString(),
            p_next_action_type:values.next_action_type,
            p_next_action_at:new Date(values.next_action_at).toISOString()
          }),
          'تم تسجيل النشاط وإنشاء مهمة المتابعة الجديدة'
        )}
      >
        <ModalHeader title={`تسجيل نشاط · ${modal.record.title}`} onClose={closeModal}/>
        <div className="mt-form">
          <label className="mt-field">نوع النشاط<select name="activity_type" required><option value="call">مكالمة</option><option value="meeting">اجتماع</option><option value="whatsapp">واتساب</option><option value="email">بريد إلكتروني</option><option value="offer">إرسال عرض</option></select></label>
          <label className="mt-field">النتيجة<input name="outcome" placeholder="مثال: مهتم ويحتاج موافقة"/></label>
          <label className="mt-field wide">ملخص ما حدث<textarea name="summary" rows="4" required/></label>
          <label className="mt-field">الإجراء التالي<select name="next_action_type" required><option value="call">مكالمة</option><option value="meeting">اجتماع</option><option value="whatsapp">واتساب</option><option value="offer">إرسال عرض</option><option value="follow_up">متابعة</option></select></label>
          <label className="mt-field">موعد الإجراء التالي<input name="next_action_at" type="datetime-local" required/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <ModalFooter busy={busy} onClose={closeModal} label="حفظ النشاط والمتابعة"/>
      </form>}
    </div>}
  </>;
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
