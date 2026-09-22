'use client';

import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import styles from './platform-tenant-controls.module.css';
import academyStyles from './platform-academy-controls.module.css';

const roles={manager:'مدير المنصة',website_editor:'محرر الموقع',instructor:'محاضر'};
const newToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),value=>value.toString(16).padStart(2,'0')).join('');
const dateValue=value=>value?new Date(value).toISOString().slice(0,16):'';

export default function PlatformAcademyControls({tenant,onClose}){
  const [state,setState]=useState(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[invitation,setInvitation]=useState('');
  const [enabled,setEnabled]=useState(false),[mode,setMode]=useState('connected');
  const [components,setComponents]=useState({lms:true,website:true,store:true});
  const [accessUntil,setAccessUntil]=useState(''),[reason,setReason]=useState('');
  const [email,setEmail]=useState(''),[role,setRole]=useState('manager');
  const dialog=useRef(null),request=useRef(null),inFlight=useRef(false),command=useRef(null),mounted=useRef(true),close=useRef(onClose);
  useEffect(()=>{close.current=onClose;},[onClose]);

  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    try{
      const response=await fetch(`/api/platform/academy-controls?slug=${encodeURIComponent(tenant.slug)}`,{cache:'no-store',signal:controller.signal});
      const result=await response.json();
      const current=result.data?.tenants?.find(item=>item.slug===tenant.slug);
      if(!response.ok||!current)throw Error(result.error||'تعذر تحميل إعدادات المنصة.');
      if(controller.signal.aborted)return;
      setState({...current,actions:result.data.actions||{}});setEnabled(current.enabled===true);setMode(current.mode||'connected');
      setComponents(current.components||{lms:true,website:true,store:true});setAccessUntil(dateValue(current.accessUntil));
    }catch(e){if(e.name!=='AbortError'&&mounted.current)setError(e.message||'تعذر التحميل.');}
    finally{if(mounted.current&&request.current===controller)setLoading(false);}
  },[tenant.slug]);

  useEffect(()=>{
    mounted.current=true;load();const priorFocus=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.current?.focus();
    function keydown(event){
      if(event.key==='Escape'&&!inFlight.current){event.preventDefault();close.current();return;}
      if(event.key!=='Tab')return;
      const items=[...(dialog.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')||[])].filter(el=>el.getClientRects().length);
      const first=items[0],last=items.at(-1);
      if(!first){event.preventDefault();dialog.current?.focus();return;}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',keydown);
    return()=>{mounted.current=false;request.current?.abort();document.body.style.overflow=overflow;document.removeEventListener('keydown',keydown);if(priorFocus instanceof HTMLElement)priorFocus.focus();};
  },[load]);

  async function mutate(action,payload){
    if(inFlight.current||loading)return;
    const key=JSON.stringify({action,payload});
    if(command.current?.key!==key){
      command.current={key,body:{slug:tenant.slug,action,commandId:crypto.randomUUID(),payload:{...payload}}};
      if(action==='issue_invitation'){
        command.current.body.invitationToken=newToken();
        command.current.body.payload.expiresAt=new Date(Date.now()+7*86400000).toISOString();
      }
    }
    inFlight.current=true;setBusy(true);setError('');setNotice('');setInvitation('');
    try{
      const response=await fetch('/api/platform/academy-controls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command.current.body),cache:'no-store'});
      const result=await response.json();if(!response.ok||!result.success)throw Error(result.error||'تعذر تأكيد نتيجة الطلب. أعد المحاولة بنفس البيانات.');
      if(!mounted.current)return;
      if(result.invitationUrl)setInvitation(new URL(result.invitationUrl,window.location.origin).href);
      command.current=null;setNotice(action==='configure'?'تم حفظ إعدادات المنصة.':action==='issue_invitation'?'دعوة التفعيل جاهزة للنسخ والمشاركة.':'تم تحديث صلاحيات المستخدم.');
      await load();
    }catch(e){if(mounted.current)setError(e.message||'تعذر تأكيد النتيجة.');}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }

  const blocked=busy||loading||!state;
  const configBlocked=blocked||state?.pilotEligible!==true||state?.actions?.canConfigure!==true;
  const membersBlocked=blocked||state?.pilotEligible!==true||state?.actions?.canManageMembers!==true;
  const trialNeedsBilling=enabled&&Boolean(accessUntil)&&state?.actions?.canGrantTrial!==true;
  return <div className={styles.layer} dir="rtl">
    <button type="button" className={styles.backdrop} aria-label="إغلاق إعدادات المنصة" tabIndex={-1} disabled={busy} onClick={onClose}/>
    <section className={`${styles.dialog} ${academyStyles.dialog}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="academy-controls-title" tabIndex={-1}>
      <header className={styles.header}><div><small>المنصة التدريبية</small><h2 id="academy-controls-title">{tenant.name}</h2><span dir="ltr">{tenant.slug}</span></div><button type="button" className={styles.close} aria-label="إغلاق" disabled={busy} onClick={onClose}>×</button></header>
      <div className={styles.body}>
        {loading&&<p role="status">جارٍ تحميل إعدادات المنصة…</p>}
        {error&&<div className={styles.error} role="alert">{error}<button type="button" disabled={busy||loading} onClick={load}>إعادة تحميل</button></div>}
        {notice&&<p className={styles.notice} role="status">{notice}</p>}
        {state&&<>
          <form className={styles.card} onSubmit={event=>{event.preventDefault();mutate('configure',{expectedVersion:state.version||0,enabled,mode,components,accessUntil:accessUntil===dateValue(state.accessUntil)?state.accessUntil||null:accessUntil?new Date(`${accessUntil}Z`).toISOString():null,reason});}}>
            <header><span className={styles.step}>1</span><div><h3>الاشتراك وإتاحة المكونات</h3><p>الموقع والمتجر ومنصة التعلّم في لوحة واحدة.</p></div></header>
            {!state.pilotEligible&&<p className={styles.hint}>التفعيل التجريبي متاح لمركز ماركتون حاليًا.</p>}
            <div className={styles.fields}>
              <label>حالة المنصة<select value={String(enabled)} disabled={configBlocked} onChange={event=>setEnabled(event.target.value==='true')}><option value="false">متوقفة</option><option value="true">مفعلة</option></select></label>
              <label>طريقة التشغيل<select value={mode} disabled={configBlocked} onChange={event=>setMode(event.target.value)}><option value="connected">مرتبطة بأودير</option><option value="standalone">مستقلة</option></select></label>
            </div>
            <p className={styles.hint}>{mode==='standalone'?'يدير فريق المنصة التسجيل وسداد طلبات متجر الدورات من لوحة المنصة.':'تظل مراجعة الدفع والقبول مرتبطة بصلاحيات فريق أودير.'}</p>
            <fieldset disabled={configBlocked} className={styles.fields}><legend>مكونات الاشتراك</legend>{[['website','الموقع الإلكتروني'],['store','متجر الدورات'],['lms','منصة التعلّم']].map(([key,label])=><label key={key}><input type="checkbox" checked={components[key]===true} onChange={event=>setComponents(current=>({...current,[key]:event.target.checked}))}/>{label}</label>)}</fieldset>
            <label className={academyStyles.field}>نهاية التجربة، بتوقيت UTC<input type="datetime-local" value={accessUntil} disabled={configBlocked||state.actions.canGrantTrial!==true} onChange={event=>setAccessUntil(event.target.value)}/></label>
            <p className={styles.muted}>مدة التجربة حتى 30 يومًا. اترك التاريخ فارغًا لاستخدام استحقاقات الاشتراك القائمة. تُدار الأسعار من كتالوج الإضافات الموحد.</p>
            {trialNeedsBilling&&<p className={styles.hint}>تعديل إعدادات تجربة مفعلة يحتاج صلاحية إدارة الفوترة. يمكنك إيقاف المنصة من حالة المنصة.</p>}
            <label className={academyStyles.field}>سبب التغيير<textarea required minLength={5} maxLength={500} value={reason} disabled={configBlocked} onChange={event=>setReason(event.target.value)} placeholder="سبب تفعيل المنصة أو تغيير إعداداتها"/></label>
            <button type="submit" className={styles.primary} disabled={configBlocked||trialNeedsBilling}>{busy?'جارٍ الحفظ…':'حفظ إعدادات المنصة'}</button>
          </form>
          <section className={styles.card}>
            <header><span className={styles.step}>2</span><div><h3>مستخدمو المنصة</h3><p>صلاحيات خاصة بإدارة المنصة والتدريب.</p></div></header>
            <div className={styles.fields}><label>البريد الإلكتروني<input type="email" value={email} disabled={membersBlocked} onChange={event=>setEmail(event.target.value)} autoComplete="off" maxLength={254}/></label><label>الدور<select value={role} disabled={membersBlocked} onChange={event=>setRole(event.target.value)}>{Object.entries(roles).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>
            <div className="mt-page-actions"><button type="button" className={styles.primary} disabled={membersBlocked||!email} onClick={()=>mutate('issue_invitation',{email,role})}>إنشاء دعوة تفعيل</button><button type="button" className={styles.secondary} disabled={membersBlocked||!email} onClick={()=>mutate('set_member',{email,role,status:'active'})}>ربط حساب قائم</button></div>
            {invitation&&<div className={styles.notice}><label>رابط الدعوة<input dir="ltr" readOnly value={invitation}/></label><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(invitation);setNotice('تم نسخ رابط الدعوة.');}catch{setError('تعذر النسخ التلقائي. انسخ الرابط من الحقل.');}}}>نسخ الرابط</button></div>}
            <div className="mt-table-wrap"><table className="mt-table"><thead><tr><th>المستخدم</th><th>الدور</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{(state.academyMembers||[]).map(member=><tr key={member.subjectId}><td>{member.name}<small>{member.email}</small></td><td>{roles[member.role]||member.role}</td><td>{member.status==='active'?'نشط':'موقوف'}</td><td><button type="button" className={styles.secondary} disabled={membersBlocked} onClick={()=>mutate('set_member',{email:member.email,role:member.role,status:member.status==='active'?'suspended':'active'})}>{member.status==='active'?'إيقاف الوصول':'تفعيل الوصول'}</button></td></tr>)}</tbody></table></div>
            {!state.academyMembers?.length&&<p className={styles.muted}>لا توجد حسابات مستقلة مضافة بعد.</p>}
          </section>
        </>}
      </div>
      <footer className={styles.footer}>{state?.enabled?<Link href={`/academy/${encodeURIComponent(tenant.slug)}`} className={styles.secondary}>فتح لوحة المنصة</Link>:<span>البيانات محفوظة عند إيقاف المنصة.</span>}<button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>إغلاق</button></footer>
    </section>
  </div>;
}
