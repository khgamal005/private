import {notFound} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../components/training-journey-workspace';
import {getAcademyAccess} from '../../../../lib/academy-server';
import {getTrainingSnapshot} from '../../../../lib/training-snapshot';
export const dynamic='force-dynamic';
export default async function AcademyOperationsPage({params,searchParams}){
  const {slug}=await params,search=await searchParams;
  const access=await getAcademyAccess(slug,{requiredComponent:'lms'});
  if(access.mode!=='connected'||access.odeirAccess!==true)notFound();
  const initialData=await getTrainingSnapshot(slug,{workspace:'academy',role:'manager'});
  if(!initialData.operations?.enabled)notFound();
  return <TrainingJourneyWorkspace slug={slug} initialData={initialData} initialView={search?.view==='tasks'?'tasks':'admissions'} workspace="academy" canOpenOperations/>;
}
