'use client';

import {useState} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';

export default function LoginForm(){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const router=useRouter();
  const search=useSearchParams();
  const invitationToken=search.get('invite');

  async function submit(event){
    event.preventDefault();
    setLoading(true);setError('');
    const form=new FormData(event.currentTarget);
    const response=await fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        email:form.get('email'),
        password:form.get('password'),
        invitationToken
      })
    });
    const data=await response.json();
    setLoading(false);
    if(!response.ok){
      setError(data.error||'تعذر تسجيل الدخول');
      return;
    }
    const requested=search.get('next');
    router.replace(
      data.context?.subject?.mustChangePassword
        ?'/change-password'
        :requested||data.next||'/control'
    );
    router.refresh();
  }

  return <form className="auth-form" onSubmit={submit}>
    {invitationToken&&<div className="form-success">سجّل الدخول بالبريد المدعو وسيتم ربط حسابك بالمنشأة تلقائيًا.</div>}
    <label>البريد الإلكتروني<input name="email" type="email" defaultValue={invitationToken?'':'admin@marktone.sa'} autoComplete="email" required/></label>
    <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" required/></label>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>{loading?'جارٍ التحقق...':invitationToken?'تسجيل الدخول وقبول الدعوة':'تسجيل الدخول'}</button>
    <small>الدخول محمي ومربوط بصلاحيات ماركتون وبيانات المنشأة.</small>
  </form>;
}
