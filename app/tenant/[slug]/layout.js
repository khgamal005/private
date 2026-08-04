import {getTenant,getTenantRoleDashboard} from '../../../lib/api';
import {requireTenant} from '../../../lib/server-auth';
import {navigationPolicyRoleKey} from '../../../lib/tenant-role-policy';
import WorkspaceShell from '../../../components/workspace-shell';
import MyRoleGuide from '../../../components/my-role-guide';

export const dynamic='force-dynamic';

export default async function TenantLayout({children,params}){
  const {slug}=await params;
  const context=await requireTenant(slug);
  const [data,dashboard]=await Promise.all([
    getTenant(slug),
    getTenantRoleDashboard(slug).catch(()=>null)
  ]);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const roleKey=context.platformAccess
    ?'platform_owner'
    :dashboard?.viewer?.roleKey||membership?.roles?.[0]||'member';
  const userName=dashboard?.viewer?.name||context.subject?.fullName||context.subject?.email?.split('@')[0];
  const roleLabel=context.platformAccess
    ?'إدارة منصة ماركتون'
    :dashboard?.viewer?.roleLabel||roleName(roleKey);
  const permissions=membership?.permissions||[];
  const guideRoleKey=roleKey==='admissions_officer'?'customer_service':roleKey;
  const navigationRoleKey=navigationPolicyRoleKey(permissions,{platformAccess:Boolean(context.platformAccess)});

  return <WorkspaceShell
    kind="tenant"
    slug={slug}
    title={data?.tenant?.name||'منشأة ماركتون'}
    email={context.subject.email}
    userName={userName}
    permissions={permissions}
    platformAccess={context.platformAccess}
    roleKey={navigationRoleKey}
    roleLabel={roleLabel}
    notificationSummary={headerSummary(dashboard)}
  >
    {children}
    <MyRoleGuide
      slug={slug}
      userName={userName}
      roleKey={guideRoleKey}
      roleLabel={roleLabel}
      permissions={permissions}
      platformAccess={context.platformAccess}
    />
  </WorkspaceShell>;
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
    pendingAdmissions:executive.pendingAdmissions||training.pendingAdmissions||0
  };
}

function roleName(roleKey){
  return ({
    tenant_owner:'مالك المنشأة',tenant_admin:'مدير المنشأة',executive_manager:'المدير التنفيذي',
    sales_manager:'مدير المبيعات',sales_supervisor:'مشرف المبيعات',sales_user:'مسؤول مبيعات',
    customer_service:'خدمة العملاء',data_officer:'مسؤول البيانات',data_analyst:'محلل البيانات',
    training_manager:'مدير التدريب',admissions_officer:'مسؤول التسجيل والقبول',
    platform_owner:'إدارة منصة ماركتون'
  })[roleKey]||'مستخدم المنشأة';
}
