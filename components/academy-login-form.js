'use client';
import {useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';
import {validAcademySlug} from '../lib/academy-policy.mjs';
export default function AcademyLoginForm({initialSlug='',passwordRequired=false,resetSuccess=false}){
  const [slug,setSlug]=useState(initialSlug),[mode,setMode]=useState(passwordRequired?'recover':'login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false);
  async function submit(event){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch(`/api/academy-auth/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,email:form.get('email'),...(mode==='login'?{password:form.get('password')}:{})}),cache:'no-store',credentials:'same-origin'});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){if(result.passwordRequired)setMode('recover');throw Error(result.error||'تعذر إتمام الطلب. حاول مرة أخرى.');}
      if(mode==='recover'){setSent(true);return;}
      replaceDocument(result.next,{fallback:`/academy/${encodeURIComponent(slug)}`});
    }catch(err){setError(err instanceof Error?err.message:'تعذر الاتصال. حاول مرة أخرى.');}finally{setBusy(false);}
  }
  return <form className="auth-form" onSubmit={submit}>
    {resetSuccess&&<p className="form-success" role="status">تم تغيير كلمة المرور. يمكنك الدخول الآن.</p>}
    {passwordRequired&&<p>قبل متابعة العمل، عيّن كلمة مرور خاصة بك من خلال رابط استعادة الحساب.</p>}
    <label>رابط المنشأة<input name="tenantSlug" dir="ltr" value={slug} onChange={event=>setSlug(event.target.value.trim().toLowerCase())} pattern="[a-z0-9][a-z0-9-]{0,63}" maxLength={64} placeholder="marktone" autoCapitalize="none" spellCheck={false} required disabled={busy}/></label>
    {sent?<p className="form-success" role="status">إذا كان البريد مسجلًا فسيصل إليه رابط لتعيين كلمة مرور جديدة. افحص البريد غير المرغوب أيضًا.</p>:<>
      <label>البريد الإلكتروني<input name="email" type="email" dir="ltr" autoComplete="username" autoCapitalize="none" maxLength={254} spellCheck={false} required disabled={busy}/></label>
      {mode==='login'&&<label>كلمة المرور<input name="password" type="password" autoComplete="current-password" maxLength={256} required disabled={busy}/></label>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy||!validAcademySlug(slug)}>{busy?'جارٍ التحقق…':mode==='login'?'دخول إدارة المنصة':'إرسال رابط الاستعادة'}</button>
    </>}
    <button type="button" disabled={busy} onClick={()=>{setMode(mode==='login'?'recover':'login');setError('');setSent(false);}}>{mode==='login'?'نسيت كلمة المرور؟':'العودة إلى تسجيل الدخول'}</button>
    {validAcademySlug(slug)&&<a href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy`}>دخول المتدربين والمحاضرين</a>}
  </form>;
}
