import PlatformAccessManager from '../../../components/platform-access-manager';
import {getPlatformAccess} from '../../../lib/platform-api';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PlatformTeamPage(){
  await requirePlatformPermission('platform.access.manage');
  const data=await getPlatformAccess();
  return <PlatformAccessManager initialData={data}/>;
}
