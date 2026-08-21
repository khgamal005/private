import ResetPasswordForm from '../../components/reset-password-form';
import MarktoneLogo from '../../components/marktone-logo';

export const revalidate=300;
export const metadata={title:'تعيين كلمة مرور جديدة | أودير'};

export default function ResetPassword(){
  return <main className="auth-page">
    <section className="auth-card narrow">
      <div className="auth-brand"><MarktoneLogo subtitle="حماية الحساب"/></div>
      <div className="auth-copy">
        <p>رابط آمن لمرة واحدة</p>
        <h1>عيّن كلمة مرور جديدة</h1>
        <span>بعد الحفظ ستعود إلى صفحة الدخول لاستخدام كلمة المرور الجديدة.</span>
      </div>
      <ResetPasswordForm/>
    </section>
  </main>;
}
