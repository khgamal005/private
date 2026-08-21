'use client';

import {useEffect,useRef,useState} from 'react';
import {replaceDocument} from '../lib/full-document-navigation.mjs';

const linkStyle={
  color:'#315769',
  display:'inline-block',
  fontWeight:700,
  marginTop:'4px',
  textAlign:'center',
  textDecoration:'none'
};

export default function ResetPasswordForm(){
  const initialized=useRef(false);
  const [credential,setCredential]=useState(null);
  const [ready,setReady]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');

  useEffect(()=>{
    if(initialized.current)return;
    initialized.current=true;

    const hash=new URLSearchParams(window.location.hash.replace(/^#/,''));
    const query=new URLSearchParams(window.location.search);
    const accessToken=hash.get('access_token');
    const tokenHash=query.get('token_hash');
    const flowType=hash.get('type')||query.get('type');
    const providerError=hash.get('error_description')
      ||query.get('error_description');

    if(providerError){
      setError('انتهت صلاحية رابط الاستعادة أو تم استخدامه من قبل. اطلب رابطًا جديدًا.');
    }else if(flowType&&flowType!=='recovery'){
      setError('رابط الاستعادة غير صالح. اطلب رابطًا جديدًا.');
    }else if(accessToken){
      setCredential({accessToken});
    }else if(tokenHash){
      setCredential({tokenHash});
    }else{
      setError('رابط الاستعادة غير صالح أو انتهت صلاحيته.');
    }

    window.history.replaceState({},'',window.location.pathname);
    setReady(true);
  },[]);

  async function submit(event){
    event.preventDefault();
    if(!credential)return;
    setLoading(true);
    setError('');
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch('/api/auth/reset-password',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          ...credential,
          password:form.get('password'),
          confirm:form.get('confirm')
        }),
        cache:'no-store'
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        setLoading(false);
        setError(data.error||'تعذر تعيين كلمة المرور');
        return;
      }
      replaceDocument('/login?reset=success',{fallback:'/login'});
    }catch{
      setLoading(false);
      setError('تعذر الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.');
    }
  }

  if(!ready){
    return <div className="auth-form"><small>جارٍ التحقق من رابط الاستعادة...</small></div>;
  }

  if(!credential){
    return <div className="auth-form">
      {error&&<div className="form-error">{error}</div>}
      <a href="/forgot-password" style={linkStyle}>طلب رابط استعادة جديد</a>
      <a href="/login" style={linkStyle}>العودة إلى تسجيل الدخول</a>
    </div>;
  }

  return <form className="auth-form" onSubmit={submit}>
    <label>كلمة المرور الجديدة<input
      name="password"
      type="password"
      minLength="12"
      autoComplete="new-password"
      required
    /></label>
    <label>تأكيد كلمة المرور<input
      name="confirm"
      type="password"
      minLength="12"
      autoComplete="new-password"
      required
    /></label>
    <p className="password-hint">استخدم 12 حرفًا على الأقل.</p>
    {error&&<div className="form-error">{error}</div>}
    <button disabled={loading}>
      {loading?'جارٍ الحفظ...':'حفظ كلمة المرور الجديدة'}
    </button>
  </form>;
}
