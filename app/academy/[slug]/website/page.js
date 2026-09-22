import CmsStudio from '../../../../components/cms-studio';
import {getAcademyAccess} from '../../../../lib/academy-server';
import {trainingRpc} from '../../../../lib/training-server';

export const dynamic='force-dynamic';

export default async function AcademyWebsitePage({params}){
  const {slug}=await params;
  await getAcademyAccess(slug,{requiredComponent:'website',permission:'manageWebsite'});
  const data=await trainingRpc('v3_cms_workspace_snapshot',{p_site_key:'marktone-main',p_tenant_slug:slug});
  return <CmsStudio initialData={{...data,context:{...data.context,workspace:'academy'}}}/>;
}
