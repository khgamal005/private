import TrainingAccessForm from '../../../components/training-access-form';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';
export const metadata={title:'دخول التدريب',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function TrainingLoginPage({searchParams}){
  const search=await searchParams;
  let next=null;
  if(typeof search?.next==='string'&&search.next.startsWith('/training/')&&!search.next.startsWith('//')){
    try{next=new URL(search.next,'https://odeir.com');}catch{}
  }
  const academy=search?.workspace==='academy'||next?.searchParams.get('workspace')==='academy';
  const target=search?.tenant||next?.pathname.split('/')[2];
  const slug=academy&&validAcademySlug(target)?target:'marktone';
  const role=search?.role==='instructor'||next?.searchParams.get('role')==='instructor'?'instructor':'learner';
  return <main style={{maxWidth:480,margin:'8vh auto',padding:24}}><TrainingAccessForm initialRole={role} tenantSlug={slug} workspace={academy?'academy':'odeir'} resetSuccess={search?.reset==='success'}/></main>;
}
