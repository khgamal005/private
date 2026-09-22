import {notFound} from 'next/navigation';
import TrainingAccessForm from '../../../components/training-access-form';
import AcademyAuthShell from '../../../components/academy-auth-shell';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'تفعيل حساب التدريب',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function AcceptTrainingInvitationPage({searchParams}){
  const search=await searchParams,academy=search?.workspace==='academy',zoom=search?.workspace==='zoom';
  if((academy||zoom)&&!validAcademySlug(search?.tenant))notFound();
  return <AcademyAuthShell experience="learner" tenantName={academy||zoom?search.tenant:''}><TrainingAccessForm invitation tenantSlug={academy||zoom?search.tenant:'marktone'} workspace={zoom?'zoom':academy?'academy':'odeir'}/></AcademyAuthShell>;
}
