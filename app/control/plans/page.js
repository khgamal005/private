import PlatformPlans from '../../../components/platform-plans';
import {getPlatformCommerce} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PlansPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformPlans initialData={await getPlatformCommerce()}/>;
}
