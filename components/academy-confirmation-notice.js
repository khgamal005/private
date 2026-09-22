'use client';

import {useEffect} from 'react';
import {academyLoginPath} from '../lib/academy-policy.mjs';

export default function AcademyConfirmationNotice({tenantSlug,training=false}){
  useEffect(()=>{
    // Provider confirmations may contain access/refresh tokens or a one-time
    // code. This landing page never uses or stores those credentials.
    window.history.replaceState(null,'',`${window.location.pathname}${tenantSlug?`?tenant=${encodeURIComponent(tenantSlug)}`:''}`);
  },[tenantSlug]);
  const login=training&&tenantSlug?`/training/login?tenant=${encodeURIComponent(tenantSlug)}&workspace=academy&role=learner`:academyLoginPath(tenantSlug);
  return <section className="auth-form">
    <h1>استكمال قبول الدعوة</h1>
    <p>بعد تأكيد بريدك الإلكتروني، افتح رابط الدعوة الأصلي واختر «لدي حساب بالفعل» لاستكمال ربط حسابك بالمنشأة.</p>
    <p>إذا ظهرت مشكلة في رابط تأكيد البريد، تواصل مع المنشأة لاستكمال التفعيل.</p>
    <a href={login}>{training?'دخول المتدرب':'دخول إدارة المنصة'}</a>
  </section>;
}
