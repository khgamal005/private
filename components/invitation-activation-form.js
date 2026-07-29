'use client';

import Link from 'next/link';
import {useState} from 'react';
import {useRouter} from 'next/navigation';

export default function InvitationActivationForm({token,invitation}){
  const router=useRouter();
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');

  async function submit(event){
    event.preventDefault();
    setLoading(true);setError('');
    const form=new FormData(event.currentTarget);
    const response=await fetch('/api/auth/register-invitation',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,password:form.get('password')})
    });
    const data=await response.json();
    setLoading(false);
    if(!response.ok){
      setError(data.error||'تعذر تفعيل الحساب');
      return;
    }
    router.replace(data.next||`/tenant/${invitation.tenantSlug}`);
    router.refresh();
  }

  return <div className="invitation-layout">
    <div className="auth-copy">
      <p>دعوة إلى منصة ماركتون</p>
      <h1>{invitation.tenantName}</h1>
      <span>تمت دعوتك بصلاحية «{invitation.roleName||'مستخدم المنشأة'}». فعّل حسابك للوصول إلى مساحة المنشأة المعزولة.</span>
      <dl className="invitation-summary">
        <div><dt>الاسم</dt><dd>{invitation.fullName}</dd></div>
        <div><dt>البريد</dt><dd>{invitation.email}</dd></div>
      </dl>
    </div>
    <form className="auth-form" onSubmit={submit}>
      <label>إنشاء كلمة مرور<input name="password" type="password" minLength="10" autoComplete="new-password" required/></label>
      <small>استخدم 10 أحرف على الأقل، ويفضل الجمع بين الحروف والأرقام والرموز.</small>
      {error&&<div className="form-error">{error}</div>}
      <button disabled={loading}>{loading?'جارٍ تفعيل الحساب…':'تفعيل الحساب والدخول'}</button>
      <Link className="invitation-login-link" href={`/login?invite=${encodeURIComponent(token)}`}>لديك حساب بالفعل؟ سجّل الدخول لقبول الدعوة</Link>
    </form>
  </div>;
}
