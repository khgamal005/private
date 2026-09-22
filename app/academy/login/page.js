import AcademyLoginForm from '../../../components/academy-login-form';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'دخول إدارة المنصة التدريبية | ماركتون',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function AcademyLoginPage({searchParams}){
  const search=await searchParams;
  const slug=validAcademySlug(search?.tenant)?search.tenant:'';
  return <main className="auth-page" dir="rtl"><section className="auth-card narrow"><div className="auth-copy"><p>منصة ماركتون التدريبية</p><h1>إدارة الموقع والتدريب</h1><span>ادخل إلى مساحة منشأتك لإدارة الموقع والمتجر وتجربة التعلم.</span></div><AcademyLoginForm initialSlug={slug} passwordRequired={search?.reason==='password'} resetSuccess={search?.reset==='success'}/></section></main>;
}
