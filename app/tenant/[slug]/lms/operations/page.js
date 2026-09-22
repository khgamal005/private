import {notFound} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../../components/training-journey-workspace';
import {requireTenantAddon} from '../../../../../lib/server-auth';
import {getTrainingSnapshot} from '../../../../../lib/training-snapshot';
import {TRAINING_PILOT_SLUG} from '../../../../../lib/training-request.mjs';
import {trainingOperationsAccess,isTrainingJourneyView} from '../../../../../lib/training-navigation.mjs';
import {interactiveTrainingAccess} from '../../../../../lib/interactive-training-access.mjs';
import {redirectLegacyAcademy} from '../../../../../lib/academy-legacy';

export const dynamic='force-dynamic';
export default async function TrainingOperationsPage({params,searchParams}){
  const {slug}=await params;if(slug!==TRAINING_PILOT_SLUG)notFound();
  const context=await requireTenantAddon(slug,'lms');
  const access=trainingOperationsAccess({slug,context,addonAccess:context.addonAccess});
  if(!access.enabled)notFound();
  const search=await searchParams;
  const view=typeof search?.view==='string'?search.view:access.canManageLearning?'dashboard':'admissions';
  if(!isTrainingJourneyView(view)||!access.views.some(item=>item.key===view))notFound();
  await redirectLegacyAcademy(slug,{view});
  const initialData=await getTrainingSnapshot(slug,{role:'manager'});
  const preview=interactiveTrainingAccess({slug,context,addonAccess:context.addonAccess});
  return <TrainingJourneyWorkspace key={`${slug}:${view}`} slug={slug} initialData={initialData} initialView={view} canPreviewDevelopment={preview.enabled}/>;
}
