import LmsWorkspace from '../../../../components/lms-workspace';
import {getTenantLms} from '../../../../lib/api';
import {requireTenantAddon} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function LmsPage({params}){
  const {slug}=await params;
  await requireTenantAddon(slug,'lms',{
    permission:'tenant.academy.read'
  });
  return <LmsWorkspace
    slug={slug}
    initialData={await getTenantLms(slug)}
  />;
}
