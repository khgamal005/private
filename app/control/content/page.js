import KnowledgeAdmin from '../../../components/knowledge-admin';
import {requirePlatformPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function ContentPage(){
  await requirePlatformPermission('platform.content.manage');
  return <KnowledgeAdmin embedded/>;
}
