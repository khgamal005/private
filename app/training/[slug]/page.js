import {notFound,redirect} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../components/training-journey-workspace';
import TrainingPortalShell from '../../../components/training-portal-shell';
import {accessToken} from '../../../lib/server-auth';
import {getTrainingSnapshot} from '../../../lib/training-snapshot';
import {TRAINING_PILOT_SLUG,trainingErrorMessage} from '../../../lib/training-request.mjs';
import {validAcademySlug} from '../../../lib/academy-policy.mjs';

export const dynamic='force-dynamic';
export const metadata={title:'منصة التدريب التفاعلي',robots:{index:false,follow:false}};
export default async function TrainingPortalPage({params,searchParams}){
  const {slug}=await params,search=await searchParams,academy=search?.workspace==='academy';
  if(academy?!validAcademySlug(slug):slug!==TRAINING_PILOT_SLUG)notFound();
  const role=search?.role==='instructor'?'instructor':'learner';
  const login=academy?`/training/login?tenant=${encodeURIComponent(slug)}&workspace=academy&role=${role}`:`/training/login?role=${role}`;
  if(!await accessToken())redirect(login);
  let initialData;
  try{initialData=await getTrainingSnapshot(slug,{role,...(academy?{workspace:'academy'}:{})});}
  catch(error){
    if(error?.status===401)redirect(login);
    return <main style={{maxWidth:900,margin:'5vh auto',padding:24}}><h1>منصة التدريب التفاعلي</h1><p role="alert">{trainingErrorMessage(error?.code||'forbidden')}</p><a href={login}>تسجيل الدخول بحساب التدريب</a></main>;
  }
  return <TrainingPortalShell slug={slug} tenantName={initialData.tenant.name} role={initialData.role||role} workspace={academy?'academy':'odeir'}><TrainingJourneyWorkspace slug={slug} initialData={initialData} workspace={academy?'academy':'odeir'} canOpenOperations={false}/></TrainingPortalShell>;
}
