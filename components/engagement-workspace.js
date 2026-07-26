'use client';

import {useEffect,useMemo,useState} from 'react';

const money=value=>new Intl.NumberFormat('ar-SA',{
  style:'currency',currency:'SAR',maximumFractionDigits:0
}).format(Number(value||0));
const currentMonth=()=>{
  const now=new Date();
  return {
    start:new Date(now.getFullYear(),now.getMonth(),1).toISOString().slice(0,10),
    end:new Date(now.getFullYear(),now.getMonth()+1,0).toISOString().slice(0,10)
  };
};

export default function EngagementWorkspace({slug}){
  const period=currentMonth();
  const [tab,setTab]=useState('incentives');
  const [data,setData]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [showPlan,setShowPlan]=useState(false);
  const [showAnnouncement,setShowAnnouncement]=useState(false);
  const [plan,setPlan]=useState({
    title:'حافز المبيعات الشهري',periodStart:period.start,periodEnd:period.end,
    metricType:'revenue',targetValue:100000,incentiveType:'percentage',incentiveValue:2,employeeIds:[]
  });
  const [announcement,setAnnouncement]=useState({
    type:'notice',priority:'normal',title:'',body:'',startsAt:'',endsAt:'',requiresAck:false,isPinned:false
  });

  async function api(action,{method='GET',body}={}){
    const suffix=method==='GET'?`?tenantSlug=${encodeURIComponent(slug)}`:'';
    const response=await fetch(`/api/engagement/${action}${suffix}`,{
      method,credentials:'include',
      headers:method==='GET'?undefined:{'content-type':'application/json'},
      body:body?JSON.stringify({...body,tenantSlug:slug}):undefined,
      cache:'no-store'
    });
    const payload=await response.json().catch(()=>({error:'تعذر قراءة استجابة النظام'}));
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload;
  }

  async function load(){
    try{setError('');setData(await api('snapshot'))}catch(err){setError(err.message)}
  }
  useEffect(()=>{load()},[slug]);

  const assignments=data?.assignments||[];
  const totals=useMemo(()=>assignments.reduce((result,item)=>({
    target:result.target+Number(item.target||0),
    achieved:result.achieved+Number(item.achieved||0),
    expected:result.expected+Number(item.expected||0),
    payable:result.payable+Number(item.payable||0)
  }),{target:0,achieved:0,expected:0,payable:0}),[assignments]);
  const progress=item=>Math.min(100,Math.round(Number(item.achieved||0)/Math.max(1,Number(item.target||0))*100));

  async function savePlan(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      await api('plan',{method:'POST',body:plan});
      setNotice('تم حفظ خطة الأهداف والحوافز وتفعيلها');
      setShowPlan(false);await load();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function saveAnnouncement(event){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      await api('announcement',{method:'POST',body:announcement});
      setNotice('تم نشر الرسالة داخل المنشأة');
      setAnnouncement({...announcement,title:'',body:''});
      setShowAnnouncement(false);await load();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function acknowledge(id){
    setBusy(true);
    try{await api('read',{method:'POST',body:{announcementId:id,acknowledge:true}});await load()}
    catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div><small>GOALS & WORKPLACE</small><h2>الأهداف والحوافز والتواصل الداخلي</h2><p>الإنجاز والحافز المتوقع والمستحق، مع سجل تنويهات وقرارات المنشأة.</p></div>
      <div className="mt-page-actions">
        {tab==='incentives'&&data?.user?.canManage&&<button className="mt-button primary" onClick={()=>setShowPlan(true)}>+ خطة حوافز</button>}
        {tab==='communications'&&data?.user?.canManage&&<button className="mt-button primary" onClick={()=>setShowAnnouncement(true)}>+ رسالة داخلية</button>}
      </div>
    </header>
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <div className="mt-section-tabs">
      <button className={tab==='incentives'?'active':''} onClick={()=>setTab('incentives')}>الأهداف والحوافز</button>
      <button className={tab==='communications'?'active':''} onClick={()=>setTab('communications')}>التنويهات والقرارات</button>
    </div>

    {tab==='incentives'?<>
      <section className="mt-kpis">
        <article className="mt-kpi"><span>الهدف الحالي</span><b>{money(totals.target)}</b><small>إجمالي أهداف الموظفين</small></article>
        <article className="mt-kpi"><span>المحقق</span><b>{money(totals.achieved)}</b><small>{totals.target?Math.round(totals.achieved/totals.target*100):0}% من الهدف</small></article>
        <article className="mt-kpi"><span>الحوافز المتوقعة</span><b>{money(totals.expected)}</b><small>عند تسجيل العميل أو الإنجاز</small></article>
        <article className="mt-kpi"><span>الحوافز المستحقة</span><b>{money(totals.payable)}</b><small>جاهزة للصرف بعد الاستحقاق</small></article>
      </section>
      <section className="mt-panel">
        <header className="mt-panel-head"><div><h3>أداء فريق المبيعات</h3><p>الهدف والإنجاز والحافز لكل موظف</p></div></header>
        <div className="mt-incentive-grid">
          {assignments.map(item=><article key={item.id}>
            <header><div><b>{item.employeeName}</b><small>{money(item.achieved)} من {money(item.target)}</small></div><strong>{progress(item)}%</strong></header>
            <div className="mt-progress"><i style={{width:`${progress(item)}%`}}/></div>
            <footer><span>متوقع <b>{money(item.expected)}</b></span><span>مستحق <b>{money(item.payable)}</b></span></footer>
          </article>)}
          {!assignments.length&&<div className="mt-empty">لا توجد خطة حوافز مسندة حتى الآن.</div>}
        </div>
      </section>
    </>:<section className="mt-announcement-grid">
      {(data?.announcements||[]).map(item=><article className={`mt-announcement ${item.priority}`} key={item.id}>
        <header><span>{item.type==='decision'?'قرار إداري':item.type==='offer'?'عرض':item.type==='urgent'?'تنبيه عاجل':'تنويه'}</span><time>{new Date(item.createdAt).toLocaleDateString('ar-SA')}</time></header>
        <h3>{item.title}</h3><p>{item.body}</p>
        <footer><span>{item.endsAt?`يظهر حتى ${new Date(item.endsAt).toLocaleDateString('ar-SA')}`:'بدون تاريخ انتهاء'}</span>
          {item.requiresAck&&!item.acknowledgedAt&&<button onClick={()=>acknowledge(item.id)} disabled={busy}>إقرار الاطلاع</button>}
          {item.acknowledgedAt&&<b>✓ تم الاطلاع</b>}
        </footer>
      </article>)}
      {!(data?.announcements||[]).length&&<div className="mt-panel mt-empty">لا توجد تنويهات أو قرارات منشورة.</div>}
    </section>}

    {showPlan&&<div className="mt-modal-layer"><button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setShowPlan(false)}/>
      <form className="mt-modal" onSubmit={savePlan}>
        <header><h3>إنشاء خطة أهداف وحوافز</h3><button type="button" onClick={()=>setShowPlan(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field wide">اسم الخطة<input required value={plan.title} onChange={event=>setPlan({...plan,title:event.target.value})}/></label>
          <label className="mt-field">بداية الفترة<input type="date" required value={plan.periodStart} onChange={event=>setPlan({...plan,periodStart:event.target.value})}/></label>
          <label className="mt-field">نهاية الفترة<input type="date" required value={plan.periodEnd} onChange={event=>setPlan({...plan,periodEnd:event.target.value})}/></label>
          <label className="mt-field">نوع الهدف<select value={plan.metricType} onChange={event=>setPlan({...plan,metricType:event.target.value})}><option value="revenue">الإيراد</option><option value="customers">عدد العملاء</option><option value="registrations">التسجيلات</option><option value="contracts">العقود</option></select></label>
          <label className="mt-field">قيمة الهدف<input type="number" required value={plan.targetValue} onChange={event=>setPlan({...plan,targetValue:event.target.value})}/></label>
          <label className="mt-field">نوع الحافز<select value={plan.incentiveType} onChange={event=>setPlan({...plan,incentiveType:event.target.value})}><option value="percentage">نسبة</option><option value="fixed">مبلغ ثابت</option><option value="tiered">شرائح</option></select></label>
          <label className="mt-field">قيمة الحافز<input type="number" step=".01" required value={plan.incentiveValue} onChange={event=>setPlan({...plan,incentiveValue:event.target.value})}/></label>
          <fieldset className="mt-employee-picker mt-field wide"><legend>الموظفون</legend>{(data?.employees||[]).map(employee=><label key={employee.id}><input type="checkbox" checked={plan.employeeIds.includes(employee.id)} onChange={event=>setPlan({...plan,employeeIds:event.target.checked?[...plan.employeeIds,employee.id]:plan.employeeIds.filter(id=>id!==employee.id)})}/><span>{employee.name||employee.email}</span></label>)}</fieldset>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setShowPlan(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ وتفعيل الخطة'}</button></footer>
      </form>
    </div>}

    {showAnnouncement&&<div className="mt-modal-layer"><button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setShowAnnouncement(false)}/>
      <form className="mt-modal" onSubmit={saveAnnouncement}>
        <header><h3>نشر رسالة داخلية</h3><button type="button" onClick={()=>setShowAnnouncement(false)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field">النوع<select value={announcement.type} onChange={event=>setAnnouncement({...announcement,type:event.target.value})}><option value="notice">تنويه</option><option value="decision">قرار إداري</option><option value="offer">عرض</option><option value="event">فعالية</option><option value="urgent">تنبيه عاجل</option></select></label>
          <label className="mt-field">الأهمية<select value={announcement.priority} onChange={event=>setAnnouncement({...announcement,priority:event.target.value})}><option value="normal">عادي</option><option value="important">مهم</option><option value="urgent">عاجل</option><option value="official">رسمي</option></select></label>
          <label className="mt-field wide">العنوان<input required value={announcement.title} onChange={event=>setAnnouncement({...announcement,title:event.target.value})}/></label>
          <label className="mt-field wide">المحتوى<textarea required rows="6" value={announcement.body} onChange={event=>setAnnouncement({...announcement,body:event.target.value})}/></label>
          <label className="mt-field">بداية الظهور<input type="datetime-local" value={announcement.startsAt} onChange={event=>setAnnouncement({...announcement,startsAt:event.target.value})}/></label>
          <label className="mt-field">نهاية الظهور<input type="datetime-local" value={announcement.endsAt} onChange={event=>setAnnouncement({...announcement,endsAt:event.target.value})}/></label>
          <label className="mt-check"><input type="checkbox" checked={announcement.requiresAck} onChange={event=>setAnnouncement({...announcement,requiresAck:event.target.checked})}/>يتطلب الإقرار بالاطلاع</label>
          <label className="mt-check"><input type="checkbox" checked={announcement.isPinned} onChange={event=>setAnnouncement({...announcement,isPinned:event.target.checked})}/>تثبيت أعلى السجل</label>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setShowAnnouncement(false)}>إلغاء</button><button className="mt-button primary" disabled={busy}>{busy?'جارٍ النشر…':'نشر داخل المنشأة'}</button></footer>
      </form>
    </div>}
  </>;
}
