import {
  getTenantAddonNavigation,
  getTenantDashboardLive,
  getTenantYeastarAccess
} from '../../../lib/api';
import {requireTenant,authRpc} from '../../../lib/server-auth';
import {optionalServerRead} from '../../../lib/server-resilience';
import {getTenantSupport} from '../../../lib/support-api';
import {navigationPolicyRoleKey} from '../../../lib/tenant-role-policy';
import {getTenantOdeirySnapshot} from '../../../lib/odeiry-api';
import {interactiveTrainingAccess} from '../../../lib/interactive-training-access.mjs';
import WorkspaceShell from '../../../components/workspace-shell';
import MyRoleGuide from '../../../components/my-role-guide';

export const dynamic='force-dynamic';

export default async function TenantLayout({children,params}){
  const {slug}=await params;
  const odeiryGloballyEnabled=process.env.ODEIRY_AI_ENABLED==='true';
  const odeiryManagerGloballyEnabled=process.env.ODEIRY_MANAGER_ENABLED==='true';
  const context=await requireTenant(slug);
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const [live,yeastarAccess,addonAccess,tenantSupport,odeirySnapshot]=await Promise.all([
    optionalServerRead(
      'tenant-shell-live',
      ()=>getTenantDashboardLive(slug),
      null
    ),
    optionalServerRead('tenant-shell-yeastar',()=>getTenantYeastarAccess(slug),{
      enabled:false,
      visible:false,
      configured:false,
      canView:false,
      canManage:false
    }),
    optionalServerRead('tenant-shell-addons',()=>getTenantAddonNavigation(slug),{
      enabledProductKeys:[],
      surfaces:[]
    }),
    optionalServerRead(
      'tenant-shell-support-summary',
      ()=>getTenantSupport(slug,{limit:1}),
      null
    ),
    odeiryGloballyEnabled
      ?optionalServerRead(
        'tenant-shell-odeiry-snapshot',
        ()=>getTenantOdeirySnapshot(slug),
        {available:false,enabled:false,manager:{
          allowed:false,enabled:false,available:false,reviewAvailable:false
        }}
      )
      :Promise.resolve(null)
  ]);
  const odeiryEnabled=Boolean(
    odeiryGloballyEnabled
    &&odeirySnapshot?.available===true
    &&odeirySnapshot?.enabled===true
  );
  const odeiryAccessMode=['tenant_member','platform_operator'].includes(
    odeirySnapshot?.mode
  )?odeirySnapshot.mode:null;
  const odeiryManagerEnabled=Boolean(
    odeiryGloballyEnabled
    &&odeiryManagerGloballyEnabled
    &&odeiryAccessMode==='tenant_member'
    &&odeirySnapshot?.manager?.allowed===true
    &&odeirySnapshot?.manager?.enabled===true
    &&odeirySnapshot?.manager?.available===true
  );
  const odeiryManagerReviewEnabled=Boolean(
    odeiryGloballyEnabled
    &&odeiryAccessMode==='tenant_member'
    &&odeirySnapshot?.manager?.allowed===true
    &&odeirySnapshot?.manager?.reviewAvailable===true
  );
  const roleKey=context.platformAccess
    ?'platform_owner'
    :membership?.roles?.[0]||'member';
  const userName=context.subject?.fullName||context.subject?.email?.split('@')[0];
  const roleLabel=context.platformAccess
    ?'إدارة منصة ماركتون'
    :roleName(roleKey);
  const permissions=membership?.permissions||[];
  const guideRoleKey=roleKey==='admissions_officer'?'customer_service':roleKey;
  const navigationRoleKey=navigationPolicyRoleKey(permissions,{platformAccess:Boolean(context.platformAccess)});
  const interactiveTraining=interactiveTrainingAccess({slug,context,addonAccess});
  if(interactiveTraining.enabled){
    const journey=await optionalServerRead('tenant-shell-training-navigation',
      ()=>authRpc('v1_training_journey_navigation',{p_slug:slug},{timeoutMs:8000,redirectForbidden:false}),
      {enabled:false});
    interactiveTraining.operational=journey?.enabled===true;
  }

  return <WorkspaceShell
    kind="tenant"
    slug={slug}
    title={live?.tenant?.name||membership?.tenantName||'منشأة ماركتون'}
    email={context.subject.email}
    userName={userName}
    permissions={permissions}
    platformAccess={context.platformAccess}
    roleKey={navigationRoleKey}
    roleLabel={roleLabel}
    notificationSummary={headerSummary(live)}
    supportSummary={tenantSupport?.summary||null}
    yeastarAccess={yeastarAccess}
    addonAccess={addonAccess}
    interactiveTraining={interactiveTraining}
    odeiryEnabled={odeiryEnabled}
    odeiryAccessMode={odeiryAccessMode}
    odeiryManagerEnabled={odeiryManagerEnabled}
    odeiryManagerReviewEnabled={odeiryManagerReviewEnabled}
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

function headerSummary(live){
  if(!live)return null;
  const summary=live.summary||{};
  return {
    tasksToday:summary.tasksToday||0,
    openTasks:summary.openTasks||0,
    overdueTasks:summary.overdueTasks||0,
    activitiesToday:summary.activitiesToday||0,
    activeLeads:summary.activeLeads||0,
    pendingAdmissions:summary.pendingAdmissions||0
  };
}

function roleName(roleKey){
  return ({
    tenant_owner:'مالك المنشأة',tenant_admin:'مدير المنشأة',executive_manager:'المدير التنفيذي',
    sales_manager:'مدير المبيعات',sales_supervisor:'مشرف المبيعات',sales_user:'مسؤول مبيعات',
    customer_service:'خدمة العملاء',data_officer:'مسؤول البيانات',data_analyst:'محلل البيانات',
    training_manager:'مدير التدريب',admissions_officer:'مسؤول التسجيل والقبول',
    finance_manager:'المدير المالي',accountant:'المحاسب',cashier:'أمين الصندوق',
    platform_owner:'إدارة منصة ماركتون'
  })[roleKey]||'مستخدم المنشأة';
}
