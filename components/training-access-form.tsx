'use client';

import {useEffect,useRef,useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';

export default function TrainingAccessForm({invitation=false,initialRole='learner'}:{invitation?:boolean;initialRole?:'learner'|'instructor'}){
  const [token,setToken]=useState('');
  const [ready,setReady]=useState(!invitation);
  const [mode,setMode]=useState<'register'|'login'>(invitation?'register':'login');
  const [role,setRole]=useState<'learner'|'instructor'>(invitation?'learner':initialRole);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const command=useRef('');
  useEffect(()=>{
    if(!invitation)return;
    const value=window.location.hash.slice(1);
    if(/^[0-9a-f]{64}$/.test(value))setToken(value);
    else setError('رابط الدعوة غير مكتمل. افتح الرابط الذي أرسله المركز.');
    // Keep the bearer invitation out of navigation, referrers and history.
    window.history.replaceState(null,'',window.location.pathname);
    setReady(true);
  },[invitation]);

  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    setBusy(true);setError('');
    if(!command.current)command.current=crypto.randomUUID();
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch(`/api/training-auth/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password'),role,...(token?{token,commandId:command.current}:{})}),cache:'no-store',credentials:'same-origin'});
      const result=await response.json();
      if(!response.ok){setError(result.error||'تعذر الدخول الآن. حاول مرة أخرى.');return;}
      replaceDocument(result.next,{fallback:'/training/marktone'});
    }catch{setError('تعذر تأكيد نتيجة الطلب. أعد المحاولة أو استخدم تسجيل الدخول لو تم إنشاء الحساب.');}
    finally{setBusy(false);}
  }

  return <form className="auth-form" onSubmit={submit}>
    <h1>{invitation?'تفعيل حساب التدريب':role==='instructor'?'دخول المحاضر':'دخول المتدرب'}</h1>
    <p>منصة التدريب التفاعلي · مركز ماركتون</p>
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
    {mode==='login'&&<a href="/forgot-password">نسيت كلمة المرور؟</a>}
    <a href="/login">دخول فريق المنشأة</a>
  </form>;
}
