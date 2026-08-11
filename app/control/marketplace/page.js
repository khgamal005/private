import {redirect} from 'next/navigation';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function MarketplacePage(){
  await requirePlatformPermission('platform.billing.manage');
  redirect('/control/payments');
}
