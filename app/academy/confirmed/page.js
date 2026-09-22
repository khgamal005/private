import AcademyConfirmationNotice from '../../../components/academy-confirmation-notice';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';

export const metadata={title:'استكمال دعوة المنصة التدريبية | ماركتون',robots:{index:false,follow:false},referrer:'no-referrer'};
export const dynamic='force-dynamic';

export default async function AcademyConfirmationPage({searchParams}){
  const query=await searchParams;
  const tenantSlug=validAcademySlug(query?.tenant)?query.tenant:'';
  return <main dir="rtl" style={{maxWidth:480,margin:'8vh auto',padding:24}}><AcademyConfirmationNotice tenantSlug={tenantSlug} training={query?.type==='training'}/></main>;
}
