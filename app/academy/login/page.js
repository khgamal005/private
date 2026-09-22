import AcademyLoginForm from '../../../components/academy-login-form';
import AcademyAuthShell from '../../../components/academy-auth-shell';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'دخول إدارة المنصة التدريبية | ماركتون',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function AcademyLoginPage({searchParams}){
  const search=await searchParams;
  const slug=validAcademySlug(search?.tenant)?search.tenant:'';
  return <AcademyAuthShell experience="manager"><AcademyLoginForm initialSlug={slug} passwordRequired={search?.reason==='password'} resetSuccess={search?.reset==='success'}/></AcademyAuthShell>;
}
