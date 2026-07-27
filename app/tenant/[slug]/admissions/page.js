import AdmissionsWorkspace from '../../../../components/admissions-workspace';
import {getTenantAdmissions} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function AdmissionsPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.admissions.read');
  return <AdmissionsWorkspace
    slug={slug}
    initialData={await getTenantAdmissions(slug)}
  />;
}
