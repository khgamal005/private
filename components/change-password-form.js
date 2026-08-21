'use client';

import {useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';

export default function ChangePasswordForm(){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');

  async function submit(event){
    event.preventDefault();
    setLoading(true);
    setError('');
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch('/api/auth/change-password',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          password:form.get('password'),
          confirm:form.get('confirm')
        })
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        setLoading(false);
        setError(data.error||'تعذر تغيير كلمة المرور');
        return;
      }
      replaceDocument(data.next,{fallback:'/control'});
    }catch{
      setLoading(false);
      setError('تعذر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
    }
  }

  return <form className="auth-form" onSubmit={submit}>
    <label>كلمة المرور الجديدة<input name="password" type="password" minLength="12" required/></label>
    <label>تأكيد كلمة المرور<input name="confirm" type="password" minLength="12" required/></label>
    <p className="password-hint">استخدم 12 حرفًا على الأقل مع حروف كبيرة وصغيرة وأرقام ورمز.</p>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>{loading?'جارٍ الحفظ...':'حفظ كلمة المرور والمتابعة'}</button>
  </form>;
}
