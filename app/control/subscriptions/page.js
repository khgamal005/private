import {getControl} from '../../../lib/api';
import PlatformSubscriptions from '../../../components/platform-subscriptions';

export const dynamic='force-dynamic';

export default async function SubscriptionsPage(){
  return <PlatformSubscriptions initialData={await getControl()}/>;
}
