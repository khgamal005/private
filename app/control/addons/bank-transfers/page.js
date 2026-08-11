import PlatformBankTransferReview from '../../../../components/platform-bank-transfer-review';
import {getPlatformBankTransfers} from '../../../../lib/marketplace-v2';
import {requirePlatformPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function BankTransfersPage(){
  await requirePlatformPermission('platform.billing.manage');
  return <PlatformBankTransferReview initialData={await getPlatformBankTransfers()}/>;
}

