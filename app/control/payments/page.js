import PlatformPayments from '../../../components/platform-payments';
import {getPlatformCommerce} from '../../../lib/api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PaymentsPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformPayments initialData={await getPlatformCommerce()}/>;
}
