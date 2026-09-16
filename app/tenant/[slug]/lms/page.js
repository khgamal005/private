import LmsWorkspace from '../../../../components/lms-workspace';
import InteractiveTrainingWorkspace from '../../../../components/interactive-training-workspace';
import {getTenantLms} from '../../../../lib/api';
import {requireTenantAddon} from '../../../../lib/server-auth';
import {interactiveTrainingAccess} from '../../../../lib/interactive-training-access.mjs';

export const dynamic='force-dynamic';

export default async function LmsPage({params}){
  const {slug}=await params;
  const context=await requireTenantAddon(slug,'lms',{
    permission:'tenant.academy.read'
  });
  const access=interactiveTrainingAccess({slug,context,addonAccess:context.addonAccess});
  if(access.enabled)return <InteractiveTrainingWorkspace
    slug={slug}
    tenantId={access.tenantId}
    subjectId={access.subjectId}
    initialView="dashboard"
    canPreviewRoles={access.canPreviewRoles}
  />;
  return <LmsWorkspace
    slug={slug}
    initialData={await getTenantLms(slug)}
  />;
}
