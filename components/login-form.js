'use client';

import {useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {replaceDocument} from '../lib/full-document-navigation.mjs';

export default function LoginForm(){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const search=useSearchParams();
  const invitationToken=search.get('invite');
  const platformInvitationToken=search.get('platformInvite');
  const requestedNext=search.get('next');
  const passwordReset=search.get('reset')==='success';
  const hasInvitation=Boolean(invitationToken||platformInvitationToken);

  async function submit(event){
    event.preventDefault();
    setLoading(true);
    setError('');
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch('/api/auth/login',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          email:form.get('email'),
          password:form.get('password'),
          invitationToken,
          platformInvitationToken,
          requestedNext
        }),
        cache:'no-store'
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        setLoading(false);
        setError(data.error||'تعذر تسجيل الدخول');
        return;
      }
      replaceDocument(data.next,{fallback:'/control'});
    }catch{
      setLoading(false);
      setError('تعذر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
    }
  }

  return <form className="auth-form" onSubmit={submit}>
    {passwordReset&&<div className="form-success">تم حفظ كلمة المرور الجديدة. يمكنك تسجيل الدخول الآن.</div>}
    {invitationToken&&<div className="form-success">سجّل الدخول بالبريد المدعو وسيتم ربط حسابك بالمنشأة تلقائيًا.</div>}
    {platformInvitationToken&&<div className="form-success">سجّل الدخول بالبريد المدعو وسيتم ربط حسابك بفريق إدارة أودير حسب الدور المحدد.</div>}
    <label>البريد الإلكتروني<input
      name="email"
      type="email"
      autoComplete="email"
      autoCapitalize="none"
      spellCheck="false"
      required
    /></label>
    <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" required/></label>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>{loading?'جارٍ التحقق...':hasInvitation?'تسجيل الدخول وقبول الدعوة':'تسجيل الدخول'}</button>
    <a href="/forgot-password" style={helpLinkStyle}>نسيت كلمة المرور؟</a>
    <small>الدخول محمي ومربوط بصلاحيات أودير الدقيقة على مستوى المنصة والمنشآت.</small>
  </form>;
}

const helpLinkStyle={
  color:'#315769',
  display:'inline-block',
  fontWeight:700,
  textAlign:'center',
  textDecoration:'none'
};
