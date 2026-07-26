import {getTenant} from '../../../lib/api';
import {requireTenant} from '../../../lib/server-auth';
import WorkspaceShell from '../../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function TenantLayout({children,params}){
  const {slug}=await params;
  const [context,data]=await Promise.all([requireTenant(slug),getTenant(slug)]);
  return <WorkspaceShell
    kind="tenant"
    slug={slug}
    title={data?.tenant?.name||'منشأة ماركتون'}
    email={context.subject.email}
  >{children}</WorkspaceShell>;
}
