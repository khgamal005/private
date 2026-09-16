import {notFound} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../../components/training-journey-workspace';
import {requireTenantAddon} from '../../../../../lib/server-auth';
import {getTrainingSnapshot} from '../../../../../lib/training-snapshot';
import {TRAINING_PILOT_SLUG} from '../../../../../lib/training-request.mjs';

export const dynamic='force-dynamic';
export default async function TrainingOperationsPage({params}){
  const {slug}=await params;if(slug!==TRAINING_PILOT_SLUG)notFound();
  await requireTenantAddon(slug,'lms');
  const initialData=await getTrainingSnapshot(slug,{role:'manager'});
  return <TrainingJourneyWorkspace slug={slug} initialData={initialData}/>;
}
