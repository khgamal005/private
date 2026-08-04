import {getPlatformControl} from '../../../lib/platform-api';
import {requirePlatformPermission} from '../../../lib/server-auth';
import PlatformSubscriptions from '../../../components/platform-subscriptions';

export const dynamic='force-dynamic';

export default async function SubscriptionsPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformSubscriptions initialData={await getPlatformControl()}/>;
}
