import Link from 'next/link';
import MarktoneLogo from '../../components/marktone-logo';
import {googleErrorMessage} from '../../lib/google-ads/ui.mjs';

export const dynamic='force-dynamic';
export const metadata={title:'استكمال ربط جوجل | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};

export default async function GoogleConnectionResult({searchParams}){
  const query=await searchParams;
  return <main className="auth-page" dir="rtl">
    <section className="auth-card narrow">
      <div className="auth-brand"><MarktoneLogo/></div>
      <div className="auth-copy">
        <p>Google Kit</p>
        <h1>لم تكتمل محاولة الربط</h1>
        <span role="alert">{googleErrorMessage(typeof query.reason==='string'?query.reason:'')}</span>
        <p>ادخل إلى منشأتك، ثم افتح إعدادات Google Kit لبدء محاولة جديدة.</p>
        <Link className="panel-link" href="/login">الدخول إلى أودير ←</Link>
      </div>
    </section>
  </main>;
}
