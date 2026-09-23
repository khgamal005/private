import TrainingAccessForm from '../../../components/training-access-form';
import AcademyAuthShell from '../../../components/academy-auth-shell';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'دخول التدريب',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function TrainingLoginPage({searchParams}){
  const search=await searchParams;
  let next=null;
  if(typeof search?.next==='string'&&search.next.startsWith('/training/')&&!search.next.startsWith('//')){
    try{next=new URL(search.next,'https://odeir.com');}catch{}
  }
  const zoom=search?.workspace==='zoom';
  const academy=search?.workspace==='academy'||next?.searchParams.get('workspace')==='academy';
  const target=search?.tenant||next?.pathname.split('/')[2];
  const slug=(academy||zoom)&&validAcademySlug(target)?target:'marktone';
  const role=search?.role==='instructor'||next?.searchParams.get('role')==='instructor'?'instructor':'learner';
  return <AcademyAuthShell experience={role} tenantName={academy?slug:''}><TrainingAccessForm initialRole={role} tenantSlug={slug} workspace={zoom?'zoom':academy?'academy':'odeir'} resetSuccess={search?.reset==='success'}/></AcademyAuthShell>;
}
