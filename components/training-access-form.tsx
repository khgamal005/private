'use client';

import {useEffect,useRef,useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';
import {academyTrainingPath} from '../lib/academy-policy.mjs';
import AcademyIcon from './academy-icon';
import styles from './academy-auth.module.css';

export default function TrainingAccessForm({invitation=false,initialRole='learner',tenantSlug='marktone',workspace='odeir',resetSuccess=false}:{invitation?:boolean;initialRole?:'learner'|'instructor';tenantSlug?:string;workspace?:'academy'|'odeir'|'zoom';resetSuccess?:boolean}){
  const [token,setToken]=useState('');
  const [ready,setReady]=useState(!invitation);
  const [mode,setMode]=useState<'register'|'login'>(invitation?'register':'login');
  const [role,setRole]=useState<'learner'|'instructor'>(invitation?'learner':initialRole);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState(false);
  const [showPassword,setShowPassword]=useState(false);
  const academy=workspace==='academy',zoom=workspace==='zoom';
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
      const response=await fetch(`/api/training-auth/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password'),role,...(academy||zoom?{workspace,tenantSlug}:{}),...(token?{token,commandId:command.current}:{})}),cache:'no-store',credentials:'same-origin'});
      const result=await response.json();
      if(!response.ok){setError(result.error||'تعذر الدخول الآن. حاول مرة أخرى.');return;}
      if(result.confirmationRequired){setConfirmation(true);setMode('login');return;}
      replaceDocument(result.next,{fallback:academy?academyTrainingPath(tenantSlug,role):'/training/marktone'});
    }catch{setError('تعذر تأكيد نتيجة الطلب. أعد المحاولة أو استخدم تسجيل الدخول لو تم إنشاء الحساب.');}
    finally{setBusy(false);}
  }

  return <form className={styles.form} onSubmit={submit}>
    <header className={styles.formHeader}><span>ODEIR LEARNING</span><h2>{invitation?'تفعيل حساب التدريب':role==='instructor'?'دخول المحاضر':'دخول المتدرب'}</h2><p>{invitation?'أكمل بياناتك لربط الحساب بدعوة المركز.':role==='instructor'?'تابع دفعاتك والحضور والتقييمات.':'تابع دوراتك ومواعيدك ونتائجك.'}</p></header>
    {resetSuccess&&<p className={styles.success} role="status">تم تغيير كلمة المرور. يمكنك الدخول الآن.</p>}
    {confirmation&&<p className={styles.success} role="status">افتح بريدك وأكد الحساب، ثم افتح رابط الدعوة الأصلي واختر «لدي حساب بالفعل» لاستكمال الربط.</p>}
    {!invitation&&<div className={styles.roleSwitch} role="group" aria-label="نوع الحساب">
      <button type="button" disabled={busy} aria-pressed={role==='learner'} onClick={()=>setRole('learner')}><AcademyIcon name="user" size={18}/> متدرب</button>
      <button type="button" disabled={busy} aria-pressed={role==='instructor'} onClick={()=>setRole('instructor')}><AcademyIcon name="teaching" size={18}/> محاضر</button>
    </div>}
    {invitation&&<div className={styles.modeSwitch} role="group" aria-label="طريقة الدخول">
      <button type="button" disabled={busy} aria-pressed={mode==='register'} onClick={()=>{setMode('register');setError('');}}>إنشاء حساب</button>
      <button type="button" disabled={busy} aria-pressed={mode==='login'} onClick={()=>{setMode('login');setError('');}}>لدي حساب بالفعل</button>
    </div>}
    {mode==='login'&&<label className={styles.field}><span>البريد الإلكتروني</span><input name="email" type="email" dir="ltr" required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="name@example.com"/></label>}
    {mode==='register'&&<p className={styles.hint}>سيتم ربط حسابك بالبريد المحدد في دعوة المركز. لو أغلقت الصفحة، افتح رابط الدعوة الأصلي مرة أخرى.</p>}
    <label className={styles.field}><span>كلمة المرور</span><div className={styles.password}><input name="password" type={showPassword?'text':'password'} required minLength={mode==='register'?12:1} maxLength={256} autoComplete={mode==='register'?'new-password':'current-password'}/><button className={styles.passwordToggle} type="button" aria-label={showPassword?'إخفاء كلمة المرور':'إظهار كلمة المرور'} aria-pressed={showPassword} onClick={()=>setShowPassword(value=>!value)}><AcademyIcon name="eye" size={18}/></button></div></label>
    {error&&<p className={styles.alert} role="alert">{error}</p>}
    <button className={styles.primary} type="submit" disabled={busy||!ready||(invitation&&!token)} data-block-reason="افتح رابط الدعوة الكامل أو انتظر انتهاء العملية.">{busy?'جارٍ التحقق…':mode==='register'?'تفعيل وبدء التدريب':invitation?'الدخول وقبول الدعوة':'تسجيل الدخول'}</button>
    <div className={styles.formFooter}>{mode==='login'&&<a className={styles.textLink} href={academy?`/forgot-password?workspace=training&tenant=${encodeURIComponent(tenantSlug)}&role=${role}`:"/forgot-password"}>نسيت كلمة المرور؟</a>}<a className={styles.textLink} href={academy?`/academy/login?tenant=${encodeURIComponent(tenantSlug)}`:"/login"}>{academy?"دخول إدارة المنصة":"دخول فريق المنشأة"}</a></div>
  </form>;
}
