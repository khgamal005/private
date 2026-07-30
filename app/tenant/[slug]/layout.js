import {getTenant,getTenantRoleDashboard} from '../../../lib/api';
import {requireTenant} from '../../../lib/server-auth';
import WorkspaceShell from '../../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function TenantLayout({children,params}){
  const {slug}=await params;
  const [context,data,dashboard]=await Promise.all([
    requireTenant(slug),
    getTenant(slug),
    getTenantRoleDashboard(slug).catch(()=>null)
  ]);
  const membership=context.memberships?.find(
    item=>item.tenantSlug===slug
  );
  return <WorkspaceShell
    kind="tenant"
    slug={slug}
    title={data?.tenant?.name||'منشأة ماركتون'}
    email={context.subject.email}
    userName={dashboard?.viewer?.name
      ||context.subject?.fullName
      ||context.subject?.email?.split('@')[0]}
    permissions={membership?.permissions||[]}
    platformAccess={context.platformAccess}
    roleLabel={context.platformAccess
      ?'إدارة منصة ماركتون'
      :dashboard?.viewer?.roleLabel
        ||roleName(membership?.roles?.[0])}
    notificationSummary={headerSummary(dashboard)}
  >{children}</WorkspaceShell>;
}

function headerSummary(dashboard){
  if(!dashboard)return null;
  const personal=dashboard.personal||{};
  const executive=dashboard.executive||{};
  const sales=dashboard.sales||{};
  const training=dashboard.training||{};
  return {
    tasksToday:personal.tasksToday||0,
    openTasks:personal.openTasks||0,
    overdueTasks:personal.overdueTasks||sales.overdueFollowUps||0,
    activitiesToday:personal.activitiesToday||0,
    activeLeads:sales.activeLeads||personal.activeLeads||0,
    pendingAdmissions:executive.pendingAdmissions
      ||training.pendingAdmissions
      ||0
  };
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
    data_analyst:'محلل البيانات',
    training_manager:'مدير التدريب'
  })[roleKey]||'مستخدم المنشأة';
}
