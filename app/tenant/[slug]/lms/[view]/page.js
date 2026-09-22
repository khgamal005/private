import {notFound} from 'next/navigation';
import InteractiveTrainingWorkspace from '../../../../../components/interactive-training-workspace';
import TrainingJourneyWorkspace from '../../../../../components/training-journey-workspace';
import {getTrainingSnapshot} from '../../../../../lib/training-snapshot';
import {requireTenantAddon} from '../../../../../lib/server-auth';
import {INTERACTIVE_TRAINING_PILOT,interactiveTrainingAccess,isInteractiveTrainingView} from '../../../../../lib/interactive-training-access.mjs';
import {isTrainingJourneyView} from '../../../../../lib/training-navigation.mjs';
import {redirectLegacyAcademy} from '../../../../../lib/academy-legacy';

export const dynamic='force-dynamic';

export default async function InteractiveTrainingViewPage({params}){
  const {slug,view}=await params;
  if(slug!==INTERACTIVE_TRAINING_PILOT.slug||(!isInteractiveTrainingView(view)&&!isTrainingJourneyView(view)))notFound();
  await redirectLegacyAcademy(slug,{view});
  const context=await requireTenantAddon(slug,'lms',{
    permission:'tenant.academy.read'
  });
  const access=interactiveTrainingAccess({slug,context,addonAccess:context.addonAccess});
  if(!access.enabled)notFound();
  const journey=await getTrainingSnapshot(slug,{role:'manager'});
  if(journey.operations?.enabled&&isTrainingJourneyView(view))return <TrainingJourneyWorkspace slug={slug} initialData={journey} initialView={view} canPreviewDevelopment={access.enabled}/>;
  if(!isInteractiveTrainingView(view))notFound();
  return <InteractiveTrainingWorkspace
    slug={slug}
    tenantId={access.tenantId}
    subjectId={access.subjectId}
    initialView={view}
    canPreviewRoles={access.canPreviewRoles}
  />;
}
