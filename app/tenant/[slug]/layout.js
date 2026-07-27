import {getTenant} from '../../../lib/api';
import {requireTenant} from '../../../lib/server-auth';
import WorkspaceShell from '../../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function TenantLayout({children,params}){
  const {slug}=await params;
  const [context,data]=await Promise.all([requireTenant(slug),getTenant(slug)]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  return <WorkspaceShell
    kind="tenant"
    slug={slug}
    title={data?.tenant?.name||'منشأة ماركتون'}
    email={context.subject.email}
    permissions={membership?.permissions||[]}
    platformAccess={context.platformAccess}
    roleLabel={context.platformAccess?'إدارة منصة ماركتون':roleName(membership?.roles?.[0])}
  >{children}</WorkspaceShell>;
}

function roleName(roleKey){
  return ({
    tenant_owner:'مالك المنشأة',
    tenant_admin:'مدير المنشأة',
    executive_manager:'المدير التنفيذي',
    sales_manager:'مدير المبيعات',
    sales_supervisor:'مشرف المبيعات',
    sales_user:'مسؤول مبيعات',
    customer_service:'خدمة العملاء',
    data_officer:'مسؤول البيانات',
    data_analyst:'محلل البيانات'
  })[roleKey]||'مستخدم المنشأة';
}
