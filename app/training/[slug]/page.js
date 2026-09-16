import {notFound,redirect} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../components/training-journey-workspace';
import {accessToken} from '../../../lib/server-auth';
import {getTrainingSnapshot} from '../../../lib/training-snapshot';
import {TRAINING_PILOT_SLUG,trainingErrorMessage} from '../../../lib/training-request.mjs';

export const dynamic='force-dynamic';
export const metadata={title:'منصة التدريب التفاعلي | أودير',robots:{index:false,follow:false}};
export default async function TrainingPortalPage({params,searchParams}){
  const {slug}=await params;if(slug!==TRAINING_PILOT_SLUG)notFound();
  if(!await accessToken())redirect('/training/login');
  const search=await searchParams;
  const role=search?.role==='instructor'?'instructor':'learner';
  let initialData;
  try{initialData=await getTrainingSnapshot(slug,{role});}
  catch(error){
    if(error?.status===401)redirect('/training/login');
    return <main style={{maxWidth:900,margin:'5vh auto',padding:24}}><h1>منصة التدريب التفاعلي</h1><p role="alert">{trainingErrorMessage(error?.code||'forbidden')}</p><a href="/training/login">تسجيل الدخول بحساب التدريب</a></main>;
  }
  return <main style={{maxWidth:1440,margin:'0 auto',padding:'20px clamp(12px,3vw,40px)'}}><TrainingJourneyWorkspace slug={slug} initialData={initialData}/></main>;
}
