'use client';

import {useState} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';

export default function LoginForm(){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const router=useRouter();
  const search=useSearchParams();
  const invitationToken=search.get('invite');
  const platformInvitationToken=search.get('platformInvite');
  const requestedNext=search.get('next');
  const hasInvitation=Boolean(invitationToken||platformInvitationToken);

  async function submit(event){
    event.preventDefault();
    setLoading(true);
    setError('');
    const form=new FormData(event.currentTarget);
    const response=await fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        email:form.get('email'),
        password:form.get('password'),
        invitationToken,
        platformInvitationToken,
        requestedNext
      })
    });
    const data=await response.json().catch(()=>({}));
    setLoading(false);
    if(!response.ok){
      setError(data.error||'تعذر تسجيل الدخول');
      return;
    }
    router.replace(data.next||'/control');
    router.refresh();
  }

  return <form className="auth-form" onSubmit={submit}>
    {invitationToken&&<div className="form-success">سجّل الدخول بالبريد المدعو وسيتم ربط حسابك بالمنشأة تلقائيًا.</div>}
    {platformInvitationToken&&<div className="form-success">سجّل الدخول بالبريد المدعو وسيتم ربط حسابك بفريق إدارة أودير حسب الدور المحدد.</div>}
    <label>البريد الإلكتروني<input name="email" type="email" defaultValue={hasInvitation?'':'admin@marktone.sa'} autoComplete="email" required/></label>
    <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" required/></label>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>{loading?'جارٍ التحقق...':hasInvitation?'تسجيل الدخول وقبول الدعوة':'تسجيل الدخول'}</button>
    <small>الدخول محمي ومربوط بصلاحيات أودير الدقيقة على مستوى المنصة والمنشآت.</small>
  </form>;
}
