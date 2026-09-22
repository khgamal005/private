'use client';

import {useEffect,useRef,useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';
import {academyBasePath} from '../lib/academy-navigation.mjs';

export default function AcademyInvitationForm({tenantSlug}){
  const secret=useRef(null);
  const [invitation,setInvitation]=useState(null);
  const [validLink,setValidLink]=useState(false);
  const [mode,setMode]=useState('login');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState(false);

  useEffect(()=>{
    // Read once per mount so React's repeated effects do not lose the secret.
    // Keep it only in memory, never in storage, queries or navigation targets.
    if(secret.current===null){
      secret.current=window.location.hash.slice(1);
      window.history.replaceState(null,'',`${window.location.pathname}${tenantSlug?`?tenant=${encodeURIComponent(tenantSlug)}`:''}`);
    }
    if(!tenantSlug||!/^[0-9a-f]{64}$/.test(secret.current)){
      setError('رابط الدعوة غير مكتمل. افتح الرابط الأصلي الذي أرسلته المنشأة.');setLoading(false);return;
    }
    setValidLink(true);
    const controller=new AbortController();
    let current=true;
    async function load(){
      try{
        const response=await fetch('/api/academy-invitations/preview',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug,token:secret.current}),
          cache:'no-store',credentials:'same-origin',signal:controller.signal
        });
        const result=await response.json();
        if(!current)return;
        if(!response.ok){setError(result.error||'تعذر التحقق من الدعوة.');return;}
        setInvitation(result);
      }catch{if(current)setError('تعذر التحقق من الدعوة. افتح الرابط الأصلي وأعد المحاولة.');}
      finally{if(current)setLoading(false);}
    }
    load();
    return ()=>{current=false;controller.abort();};
  },[tenantSlug]);

  async function submit(event){
    event.preventDefault();if(busy||loading||!validLink||(mode==='register'&&!invitation))return;
    setBusy(true);setError('');setConfirmation(false);
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch(`/api/academy-invitations/${mode}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({tenantSlug,token:secret.current,password:form.get('password'),...(mode==='login'?{email:form.get('email')}:{})}),
        cache:'no-store',credentials:'same-origin'
      });
      const result=await response.json();
      if(!response.ok){setError(result.error||'تعذر قبول الدعوة. حاول مرة أخرى.');return;}
      if(result.confirmationRequired){setConfirmation(true);setMode('login');return;}
      replaceDocument(result.next,{fallback:academyBasePath(tenantSlug)});
    }catch{setError('تعذر تأكيد نتيجة الطلب. أعد المحاولة أو سجّل الدخول إذا أُنشئ الحساب بالفعل.');}
    finally{setBusy(false);}
  }

  return <form className="auth-form" onSubmit={submit}>
    <h1>قبول دعوة المنصة التدريبية</h1>
    <p>إدارة موقع المنشأة ومنصة التدريب · ماركتون</p>
    {loading&&<p role="status">جارٍ التحقق من الدعوة…</p>}
    {!loading&&validLink&&<>
      {invitation?<label>البريد المدعو<input name="email" type="email" value={invitation.email} readOnly autoComplete="username" dir="ltr"/></label>
        :<><p>لو سبق أن قبلت الدعوة، سجّل الدخول بنفس البريد لاستكمال الدخول.</p><label>البريد الإلكتروني لحسابك<input name="email" type="email" required maxLength={254} autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr"/></label></>}
      {invitation&&<div role="group" aria-label="طريقة قبول الدعوة" style={{display:'flex',gap:12}}>
        <button type="button" disabled={busy} aria-pressed={mode==='login'} onClick={()=>{setMode('login');setError('');}}>لدي حساب</button>
        <button type="button" disabled={busy} aria-pressed={mode==='register'} onClick={()=>{setMode('register');setError('');}}>إنشاء حساب</button>
      </div>}
      {mode==='register'&&<p>أنشئ كلمة مرور من 12 حرفًا على الأقل. قد يُطلب تأكيد البريد قبل قبول الدعوة.</p>}
      <label>كلمة المرور<input key={mode} name="password" type="password" required minLength={mode==='register'?12:1} maxLength={256} autoComplete={mode==='register'?'new-password':'current-password'}/></label>
      <button type="submit" disabled={busy||loading}>{busy?'جارٍ التحقق…':mode==='register'?'إنشاء حساب وقبول الدعوة':'تسجيل الدخول وقبول الدعوة'}</button>
      {mode==='login'&&<a href={`/academy/login?tenant=${encodeURIComponent(tenantSlug)}&reason=password`}>نسيت كلمة المرور؟</a>}
    </>}
    {confirmation&&<p role="status">راجع بريدك الإلكتروني وأكد الحساب، ثم افتح رابط الدعوة الأصلي واختر «لدي حساب» لقبول الدعوة.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <p>إذا أغلقت الصفحة قبل القبول، افتح رابط الدعوة الأصلي مرة أخرى.</p>
    <a href={`/academy/login${tenantSlug?`?tenant=${encodeURIComponent(tenantSlug)}`:''}`}>دخول إدارة المنصة</a>
  </form>;
}
