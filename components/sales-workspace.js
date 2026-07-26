'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',currency:'SAR',maximumFractionDigits:0
}).format((Number(value)||0)/100);
const when=value=>value?new Date(value).toLocaleString('ar-SA',{
  day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'
}):'غير محدد';

export default function SalesWorkspace({slug,initialData}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [view,setView]=useState('pipeline');
  const [query,setQuery]=useState('');
  const [modal,setModal]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  const opportunities=data.opportunities||[];
  const contacts=data.contacts||[];
  const stages=(data.stages||[]).filter(stage=>!stage.closed);
  const shownContacts=useMemo(()=>contacts.filter(contact=>
    `${contact.name||''} ${contact.organizationName||''} ${contact.phone||''}`.toLowerCase().includes(query.toLowerCase())
  ),[contacts,query]);
  const pipelineValue=opportunities.reduce((sum,item)=>sum+Number(item.valueMinor||0),0);
  const stale=opportunities.filter(item=>item.nextActionAt&&new Date(item.nextActionAt)<new Date()).length;
  const wonStage=(data.stages||[]).find(stage=>stage.closed&&/won|فوز|مغلق.*ناجح/i.test(`${stage.key||''} ${stage.nameAr||''}`));
  const won=wonStage?opportunities.filter(item=>item.stageId===wonStage.id).length:0;

  async function call(action,body){
    const response=await fetch(`/api/crm/${action}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
    });
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }

  async function moveOpportunity(id,stageId){
    const previous=data;
    setData({...data,opportunities:opportunities.map(item=>item.id===id?{...item,stageId}:item)});
    setError('');
    try{
      await call('move-opportunity',{p_tenant_slug:slug,p_opportunity_id:id,p_stage_id:stageId});
      setMessage('تم تحديث مرحلة الفرصة');
      router.refresh();
    }catch(err){setData(previous);setError(err.message)}
  }

  async function createOpportunity(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      await call('create-opportunity',{
        p_tenant_slug:slug,
        p_title:values.title,
        p_contact_id:values.contact_id,
        p_stage_id:values.stage_id,
        p_value_minor:Math.round(Number(values.value||0)*100),
        p_service_id:values.service_id||null,
        p_owner_employee_id:values.owner_employee_id||null,
        p_expected_close_date:values.expected_close_date||null,
        p_next_action_type:values.next_action_type,
        p_next_action_at:new Date(values.next_action_at).toISOString()
      });
      setMessage('تم إنشاء الفرصة وحفظ الإجراء التالي');
      setModal(false);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div><small>SALES & CUSTOMERS</small><h2>المبيعات والعملاء والفرص</h2><p>مسار واحد واضح من العميل حتى الإغلاق والحافز المتوقع.</p></div>
      <div className="mt-page-actions"><button className="mt-button primary" onClick={()=>setModal(true)}>+ فرصة جديدة</button></div>
    </header>
    {message&&<div className="mt-alert">{message}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>قيمة الفرص</span><b>{money(pipelineValue)}</b><small>{opportunities.length} فرصة مسجلة</small></article>
      <article className="mt-kpi"><span>العملاء</span><b>{contacts.length}</b><small>أفراد وجهات ومتخذو قرار</small></article>
      <article className={`mt-kpi ${stale?'warning':''}`}><span>متابعة مستحقة</span><b>{stale}</b><small>إجراء تالٍ تجاوز موعده</small></article>
      <article className="mt-kpi"><span>فرص ناجحة</span><b>{won}</b><small>بحسب مرحلة الإغلاق الحالية</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={view==='pipeline'?'active':''} onClick={()=>setView('pipeline')}>مسار الفرص</button>
          <button className={view==='contacts'?'active':''} onClick={()=>setView('contacts')}>العملاء</button>
        </div>
        {view==='contacts'&&<input className="mt-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالاسم أو الجهة أو الجوال"/>}
      </div>

      {view==='pipeline'?<div className="mt-sales-board">
        {stages.map(stage=>{
          const items=opportunities.filter(item=>item.stageId===stage.id);
          return <section className="mt-sales-column" key={stage.id}>
            <header><div><b>{stage.nameAr}</b><small>{money(items.reduce((sum,item)=>sum+Number(item.valueMinor||0),0))}</small></div><span>{items.length}</span></header>
            <div>{items.map(item=><article className="mt-opportunity-card" key={item.id}>
              <small>{item.serviceName||'خدمة عامة'}</small>
              <h3>{item.title}</h3>
              <p>{item.organizationName||item.contactName||'عميل غير محدد'}</p>
              <strong>{money(item.valueMinor)}</strong>
              <dl><div><dt>المسؤول</dt><dd>{item.ownerName||'غير مسند'}</dd></div><div><dt>المتابعة</dt><dd>{when(item.nextActionAt)}</dd></div></dl>
              <select value={item.stageId} disabled={busy} onChange={event=>moveOpportunity(item.id,event.target.value)}>
                {(data.stages||[]).map(option=><option value={option.id} key={option.id}>{option.nameAr}</option>)}
              </select>
            </article>)}
            {!items.length&&<div className="mt-column-empty">لا توجد فرص</div>}</div>
          </section>;
        })}
      </div>:<div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>العميل</th><th>الجهة / الصفة</th><th>التواصل</th><th>المسؤول</th><th>الحالة</th></tr></thead>
        <tbody>{shownContacts.map(contact=><tr key={contact.id}>
          <td><b>{contact.name}</b><small>{contact.email||'لا يوجد بريد'}</small></td>
          <td><b>{contact.organizationName||'فرد'}</b><small>{contact.decisionRole||'غير محدد'}</small></td>
          <td><b>{contact.phone||'—'}</b><small>{contact.whatsapp?`واتساب: ${contact.whatsapp}`:'—'}</small></td>
          <td>{contact.ownerName||'غير مسند'}</td>
          <td><span className="mt-status active">{contact.status||'نشط'}</span></td>
        </tr>)}</tbody>
      </table>{!shownContacts.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}</div>}
    </section>

    {modal&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setModal(false)}/>
      <form className="mt-modal" onSubmit={createOpportunity}>
        <header><h3>إنشاء فرصة مبيعات</h3><button type="button" onClick={()=>setModal(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">عنوان الفرصة<input name="title" required/></label>
          <label className="mt-field">العميل<select name="contact_id" required><option value="">اختر العميل</option>{contacts.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">المرحلة<select name="stage_id" required><option value="">اختر المرحلة</option>{stages.map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">الدورة أو الخدمة<select name="service_id"><option value="">خدمة عامة</option>{(data.services||[]).map(item=><option value={item.id} key={item.id}>{item.nameAr}</option>)}</select></label>
          <label className="mt-field">مسؤول الفرصة<select name="owner_employee_id"><option value="">غير مسند</option>{(data.employees||[]).map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="mt-field">القيمة بالريال<input name="value" type="number" min="0" step=".01"/></label>
          <label className="mt-field">الإغلاق المتوقع<input name="expected_close_date" type="date"/></label>
          <label className="mt-field">الإجراء التالي<select name="next_action_type" required><option value="call">مكالمة</option><option value="meeting">اجتماع</option><option value="whatsapp">واتساب</option><option value="offer">إرسال عرض</option><option value="follow_up">متابعة</option></select></label>
          <label className="mt-field">موعد الإجراء<input name="next_action_at" type="datetime-local" required/></label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setModal(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ الفرصة'}</button></footer>
      </form>
    </div>}
  </>;
}
