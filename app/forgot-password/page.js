import ForgotPasswordForm from '../../components/forgot-password-form';
import MarktoneLogo from '../../components/marktone-logo';

export const revalidate=300;
export const metadata={title:'استعادة كلمة المرور | أودير'};

export default function ForgotPassword(){
  return <main className="auth-page">
    <section className="auth-card narrow">
      <div className="auth-brand"><MarktoneLogo subtitle="حماية الحساب"/></div>
      <div className="auth-copy">
        <p>استعادة آمنة للحساب</p>
        <h1>نسيت كلمة المرور؟</h1>
        <span>أدخل بريد الموظف المسجل وسنرسل إليه رابطًا صالحًا لمرة واحدة.</span>
      </div>
      <ForgotPasswordForm/>
    </section>
  </main>;
}
