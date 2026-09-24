import AdmissionsWorkspace from '../../../../components/admissions-workspace';
import {getTenantAdmissions} from '../../../../lib/api';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function AdmissionsPage({params,searchParams}){
  const {slug}=await params;
  const query=await searchParams;
  const initialView=['cases','batches','operations'].includes(query?.tab)?query.tab:'cases';
  await requireTenantPermission(slug,'tenant.admissions.read');
  return <AdmissionsWorkspace
    slug={slug}
    initialView={initialView}
    initialData={await getTenantAdmissions(slug)}
  />;
}
