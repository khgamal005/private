'use client';

import {useState} from 'react';

const linkStyle={
  color:'#315769',
  display:'inline-block',
  fontWeight:700,
  marginTop:'4px',
  textAlign:'center',
  textDecoration:'none'
};

export default function ForgotPasswordForm(){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [sent,setSent]=useState(false);

  async function submit(event){
    event.preventDefault();
    setLoading(true);
    setError('');
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch('/api/auth/request-password-reset',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:form.get('email')}),
        cache:'no-store'
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        setLoading(false);
        setError(data.error||'تعذر إرسال رابط الاستعادة');
        return;
      }
      setLoading(false);
      setSent(true);
    }catch{
      setLoading(false);
      setError('تعذر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
    }
  }

  if(sent){
    return <div className="auth-form">
      <div className="form-success">
        إذا كان البريد مسجلًا فسيصل إليه رابط آمن لتعيين كلمة مرور جديدة. افحص البريد غير المرغوب أيضًا.
      </div>
      <a href="/login" style={linkStyle}>العودة إلى تسجيل الدخول</a>
    </div>;
  }

  return <form className="auth-form" onSubmit={submit}>
    <label>البريد الإلكتروني<input
      name="email"
      type="email"
      autoComplete="email"
      autoCapitalize="none"
      spellCheck="false"
      required
    /></label>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>
      {loading?'جارٍ إرسال الرابط...':'إرسال رابط الاستعادة'}
    </button>
    <a href="/login" style={linkStyle}>العودة إلى تسجيل الدخول</a>
  </form>;
}
