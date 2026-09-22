'use client';
import {useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';
import {validAcademySlug} from '../lib/academy-policy.mjs';
import AcademyIcon from './academy-icon';
import styles from './academy-auth.module.css';
export default function AcademyLoginForm({initialSlug='',passwordRequired=false,resetSuccess=false}){
  const [slug,setSlug]=useState(initialSlug),[mode,setMode]=useState(passwordRequired?'recover':'login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false),[showPassword,setShowPassword]=useState(false);
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
  return <form className={styles.form} onSubmit={submit}>
    <header className={styles.formHeader}><span>ODEIR ACADEMY</span><h2>{mode==='login'?'مرحبًا بعودتك':'استعادة الدخول'}</h2><p>{mode==='login'?'ادخل إلى لوحة إدارة موقعك ومتجرك وتجربة التدريب.':'سنرسل رابطًا آمنًا لتعيين كلمة مرور جديدة.'}</p></header>
    {resetSuccess&&<p className={styles.success} role="status">تم تغيير كلمة المرور. يمكنك الدخول الآن.</p>}
    {passwordRequired&&<p className={styles.hint}>قبل متابعة العمل، عيّن كلمة مرور خاصة بك من خلال رابط استعادة الحساب.</p>}
    <label className={styles.field}><span>رابط المنشأة</span><input name="tenantSlug" dir="ltr" value={slug} onChange={event=>setSlug(event.target.value.trim().toLowerCase())} pattern="[a-z0-9][a-z0-9-]{0,63}" maxLength={64} placeholder="marktone" autoCapitalize="none" spellCheck={false} required disabled={busy}/></label>
    {sent?<p className={styles.success} role="status">إذا كان البريد مسجلًا فسيصل إليه رابط لتعيين كلمة مرور جديدة. افحص البريد غير المرغوب أيضًا.</p>:<>
      <label className={styles.field}><span>البريد الإلكتروني</span><input name="email" type="email" dir="ltr" autoComplete="username" autoCapitalize="none" maxLength={254} spellCheck={false} required disabled={busy} placeholder="name@company.com"/></label>
      {mode==='login'&&<label className={styles.field}><span>كلمة المرور</span><div className={styles.password}><input name="password" type={showPassword?'text':'password'} autoComplete="current-password" maxLength={256} required disabled={busy}/><button className={styles.passwordToggle} type="button" aria-label={showPassword?'إخفاء كلمة المرور':'إظهار كلمة المرور'} aria-pressed={showPassword} onClick={()=>setShowPassword(value=>!value)}><AcademyIcon name="eye" size={18}/></button></div></label>}
      {error&&<p className={styles.alert} role="alert">{error}</p>}
      <button className={styles.primary} type="submit" disabled={busy||!validAcademySlug(slug)}>{busy?'جارٍ التحقق…':mode==='login'?'دخول إدارة المنصة':'إرسال رابط الاستعادة'}</button>
    </>}
    <div className={styles.formFooter}><button className={styles.textButton} type="button" disabled={busy} onClick={()=>{setMode(mode==='login'?'recover':'login');setError('');setSent(false);}}>{mode==='login'?'نسيت كلمة المرور؟':'العودة إلى تسجيل الدخول'}</button></div>
    {validAcademySlug(slug)&&<><div className={styles.divider}>أو</div><a className={styles.portalLink} href={`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy`}><span><AcademyIcon name="teaching" size={19}/> دخول المتدربين والمحاضرين</span><AcademyIcon name="arrow" size={17}/></a></>}
  </form>;
}
