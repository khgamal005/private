import BuiltPublicPage from '../../../components/built-public-page';
import PublicSite from '../../../components/public-site';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';
import {isBuilderDocument} from '../../../lib/website-builder';

export const dynamic='force-dynamic';

export default async function CmsPublicHome(){
  const snapshot=await getCmsPublicSnapshot({siteKey:'marktone-main'});
  const home=snapshot?.homePage;
  if(home&&isBuilderDocument(home.content))return <BuiltPublicPage snapshot={snapshot} content={home}/>;
  return <PublicSite snapshot={snapshot}/>;
}
