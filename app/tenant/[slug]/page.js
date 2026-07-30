import {notFound} from 'next/navigation';
import RoleDashboard from '../../../components/role-dashboard';
import {
  getTenant,
  getTenantOperations,
  getTenantRoleDashboard
} from '../../../lib/api';
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

function fallbackDashboard(membership,operations){
  const summary=operations?.summary||{};
  const viewer=operations?.viewer||{};
  return {
    fallback:true,
    generatedAt:new Date().toISOString(),
    viewer:{
      name:'مستخدم ماركتون',
      roleKey:membership?.roles?.[0]||'tenant_user',
      roleLabel:null,
      viewTeam:Boolean(viewer.viewTeam)
    },
    personal:{
      tasksToday:summary.dueToday||0,
      openTasks:(operations?.tasks||[]).filter(task=>
        task.status!=='completed'
      ).length,
      overdueTasks:summary.overdueTasks||0,
      activitiesToday:summary.activitiesToday||0,
      activeLeads:summary.activeLeads||summary.activeContacts||0,
      paidThisMonth:summary.paidThisMonth||0
    },
    sales:{
      activeLeads:summary.activeLeads||summary.activeContacts||0,
      awaitingPayment:summary.awaitingPayment||0,
      paidThisMonth:summary.paidThisMonth||0,
      overdueFollowUps:summary.overdueTasks||0
    },
    telephony:{configured:false,mapped:false},
    leadOperations:{},
    training:{},
    executive:{},
    team:operations?.leaderboard||[],
    daily:[],
    sources:[]
  };
}

export default async function TenantOverview({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(
    slug,
    'tenant.workspace.read'
  );
  const membership=context.memberships?.find(
    item=>item.tenantSlug===slug
  );
  const permissions=membership?.permissions||[];
  const canReadCrm=Boolean(
    context.platformAccess||permissions.includes('tenant.crm.read')
  );
  const [data,operations,dashboard]=await Promise.all([
    getTenant(slug),
    getTenantOperations(slug,{includeSales:canReadCrm}),
    getTenantRoleDashboard(slug).catch(()=>null)
  ]);
  if(!data)return notFound();

  return <RoleDashboard
    slug={slug}
    dashboard={dashboard||fallbackDashboard(membership,operations)}
    operations={operations}
    permissions={context.platformAccess
      ?[
        'tenant.work.read',
        'tenant.crm.read',
        'tenant.leads.read',
        'tenant.admissions.read',
        'tenant.incentives.read',
        'tenant.settings.manage'
      ]
      :permissions}
    fallbackRoleKey={membership?.roles?.[0]}
  />;
}
