import {notFound} from 'next/navigation';
import InteractiveTrainingWorkspace from '../../../../../components/interactive-training-workspace';
import {requireTenantAddon} from '../../../../../lib/server-auth';
import {INTERACTIVE_TRAINING_PILOT,interactiveTrainingAccess,isInteractiveTrainingView} from '../../../../../lib/interactive-training-access.mjs';

export const dynamic='force-dynamic';

export default async function InteractiveTrainingViewPage({params}){
  const {slug,view}=await params;
  if(slug!==INTERACTIVE_TRAINING_PILOT.slug||!isInteractiveTrainingView(view))notFound();
  const context=await requireTenantAddon(slug,'lms',{
    permission:'tenant.academy.read'
  });
  const access=interactiveTrainingAccess({slug,context,addonAccess:context.addonAccess});
  if(!access.enabled)notFound();
  return <InteractiveTrainingWorkspace
    slug={slug}
    tenantId={access.tenantId}
    subjectId={access.subjectId}
    initialView={view}
    canPreviewRoles={access.canPreviewRoles}
  />;
}
