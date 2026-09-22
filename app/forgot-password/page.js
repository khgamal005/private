import ForgotPasswordForm from '../../components/forgot-password-form';
import MarktoneLogo from '../../components/marktone-logo';
import {recoveryContext} from '../../lib/academy-policy.mjs';

export const dynamic='force-dynamic';
export const metadata={title:'استعادة كلمة المرور | أودير'};

export default async function ForgotPassword({searchParams}){
  const search=await searchParams;
  const recovery=recoveryContext({workspace:search?.workspace,tenantSlug:search?.tenant,role:search?.role});
  return <main className="auth-page">
    <section className="auth-card narrow">
      <div className="auth-brand"><MarktoneLogo subtitle="حماية الحساب"/></div>
      <div className="auth-copy">
        <p>استعادة آمنة للحساب</p>
        <h1>نسيت كلمة المرور؟</h1>
        <span>أدخل بريد الحساب المسجل وسنرسل إليه رابطًا صالحًا لمرة واحدة.</span>
      </div>
      <ForgotPasswordForm recovery={recovery}/>
    </section>
  </main>;
}
