import WebsiteBuilderHome from '../../../../components/website-builder-home';
import {authRpc,requirePlatform} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function BuilderHomePage(){
  await requirePlatform();
  const data=await authRpc('v2_platform_site_snapshot');
  return <WebsiteBuilderHome pages={data?.pages||[]}/>;
}
