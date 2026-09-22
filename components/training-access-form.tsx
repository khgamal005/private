'use client';

import {useEffect,useRef,useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';
import {academyTrainingPath} from '../lib/academy-policy.mjs';

export default function TrainingAccessForm({invitation=false,initialRole='learner',tenantSlug='marktone',workspace='odeir',resetSuccess=false}:{invitation?:boolean;initialRole?:'learner'|'instructor';tenantSlug?:string;workspace?:'academy'|'odeir';resetSuccess?:boolean}){
  const [token,setToken]=useState('');
  const [ready,setReady]=useState(!invitation);
  const [mode,setMode]=useState<'register'|'login'>(invitation?'register':'login');
  const [role,setRole]=useState<'learner'|'instructor'>(invitation?'learner':initialRole);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState(false);
  const academy=workspace==='academy';
  const command=useRef('');
  const invitationRead=useRef(false);
  useEffect(()=>{
    if(!invitation||invitationRead.current)return;
    invitationRead.current=true;
    const value=window.location.hash.slice(1);
    if(/^[0-9a-f]{64}$/.test(value))setToken(value);
    else setError('رابط الدعوة غير مكتمل. افتح الرابط الذي أرسله المركز.');
    // Keep the bearer invitation out of navigation, referrers and history.
    window.history.replaceState(null,'',window.location.pathname+window.location.search);
    setReady(true);
  },[invitation]);

  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    setBusy(true);setError('');
    if(!command.current)command.current=crypto.randomUUID();
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch(`/api/training-auth/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password'),role,...(academy?{workspace:'academy',tenantSlug}:{}),...(token?{token,commandId:command.current}:{})}),cache:'no-store',credentials:'same-origin'});
      const result=await response.json();
      if(!response.ok){setError(result.error||'تعذر الدخول الآن. حاول مرة أخرى.');return;}
      if(result.confirmationRequired){setConfirmation(true);setMode('login');return;}
      replaceDocument(result.next,{fallback:academy?academyTrainingPath(tenantSlug,role):'/training/marktone'});
    }catch{setError('تعذر تأكيد نتيجة الطلب. أعد المحاولة أو استخدم تسجيل الدخول لو تم إنشاء الحساب.');}
    finally{setBusy(false);}
  }

  return <form className="auth-form" onSubmit={submit}>
    <h1>{invitation?'تفعيل حساب التدريب':role==='instructor'?'دخول المحاضر':'دخول المتدرب'}</h1>
    <p>منصة التدريب التفاعلي{academy?'':' · مركز ماركتون'}</p>
    {resetSuccess&&<p className="form-success" role="status">تم تغيير كلمة المرور. يمكنك الدخول الآن.</p>}
    {confirmation&&<p className="form-success" role="status">افتح بريدك وأكد الحساب، ثم افتح رابط الدعوة الأصلي واختر «لدي حساب بالفعل» لاستكمال الربط.</p>}
    {!invitation&&<label>الدخول بصفتي<select value={role} onChange={event=>setRole(event.target.value as 'learner'|'instructor')} disabled={busy}><option value="learner">متدرب</option><option value="instructor">محاضر</option></select></label>}
    {invitation&&<div role="group" aria-label="طريقة الدخول" style={{display:'flex',gap:12}}>
      <button type="button" disabled={busy} aria-pressed={mode==='register'} onClick={()=>{setMode('register');setError('');}}>إنشاء حساب</button>
      <button type="button" disabled={busy} aria-pressed={mode==='login'} onClick={()=>{setMode('login');setError('');}}>لدي حساب بالفعل</button>
    </div>}
    {mode==='login'&&<label>البريد الإلكتروني<input name="email" type="email" required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254}/></label>}
    {mode==='register'&&<p>سيتم ربط حسابك بالبريد المحدد في دعوة المركز. لو أغلقت الصفحة، افتح رابط الدعوة الأصلي مرة أخرى.</p>}
    <label>كلمة المرور<input name="password" type="password" required minLength={mode==='register'?12:1} maxLength={256} autoComplete={mode==='register'?'new-password':'current-password'}/></label>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <button type="submit" disabled={busy||!ready||(invitation&&!token)} data-block-reason="افتح رابط الدعوة الكامل أو انتظر انتهاء العملية.">{busy?'جارٍ التحقق…':mode==='register'?'تفعيل وبدء التدريب':invitation?'الدخول وقبول الدعوة':'تسجيل الدخول'}</button>
    {mode==='login'&&<a href={academy?`/forgot-password?workspace=training&tenant=${encodeURIComponent(tenantSlug)}&role=${role}`:"/forgot-password"}>نسيت كلمة المرور؟</a>}
    <a href={academy?`/academy/login?tenant=${encodeURIComponent(tenantSlug)}`:"/login"}>{academy?"دخول إدارة المنصة":"دخول فريق المنشأة"}</a>
  </form>;
}
