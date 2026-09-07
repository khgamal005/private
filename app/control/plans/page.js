import PlatformPlans from '../../../components/platform-plans';
import {authRpc} from '../../../lib/server-auth';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PlansPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformPlans initialData={await authRpc('v1_platform_core_plans_editor_snapshot')}/>;
}
