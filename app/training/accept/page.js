import {notFound} from 'next/navigation';
import TrainingAccessForm from '../../../components/training-access-form';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'تفعيل حساب التدريب',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function AcceptTrainingInvitationPage({searchParams}){
  const search=await searchParams,academy=search?.workspace==='academy';
  if(academy&&!validAcademySlug(search?.tenant))notFound();
  return <main style={{maxWidth:480,margin:'8vh auto',padding:24}}><TrainingAccessForm invitation tenantSlug={academy?search.tenant:'marktone'} workspace={academy?'academy':'odeir'}/></main>;
}
