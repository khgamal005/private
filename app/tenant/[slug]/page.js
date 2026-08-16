import AchievementBoard from '../../../components/achievement-board';
import RoleDashboard from '../../../components/role-dashboard';
import {getTenantMarketingHub} from '../../../lib/marketing-api';
import {
  getTenantDashboardLive,
  getTenantRoleDashboard
} from '../../../lib/api';
import {getTenantEmployeeAchievement} from '../../../lib/achievement';
import {resolveDashboardRange} from '../../../lib/reporting';
import {requireTenantPermission} from '../../../lib/server-auth';
import {optionalServerRead} from '../../../lib/server-resilience';

export const dynamic='force-dynamic';
const EXECUTIVE_ROLES=new Set([
  'tenant_owner',
  'tenant_admin',
  'executive_manager'
]);

function emptyLiveSnapshot(){
  return {tenant:null,viewer:{viewTeam:false},summary:{},tasks:[]};
}

function getOptionalMarketing(slug,range){
  return optionalServerRead(
    'tenant-marketing-dashboard',
    ()=>getTenantMarketingHub(slug,{
      from:range.from,
      to:range.to
    }),
    null
  );
}

function unavailableDashboard(membership){
  return {
    unavailable:true,
    generatedAt:new Date().toISOString(),
    viewer:{
      name:'مستخدم ماركتون',
      roleKey:membership?.roles?.[0]||'tenant_user',
      roleLabel:null,
      viewTeam:false
    }
  };
}

export default async function TenantOverview({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const context=await requireTenantPermission(slug,'tenant.workspace.read');
  const membership=context.memberships?.find(
    item=>item.tenantSlug===slug
  );
  const permissions=membership?.permissions||[];
  const membershipRole=membership?.roles?.[0]||'tenant_user';
  const canReadCrm=Boolean(
    context.platformAccess||permissions.includes('tenant.crm.read')
  );
  const canReadMarketing=Boolean(
    context.platformAccess||permissions.includes('tenant.marketing.read')
  );
  const live=await optionalServerRead(
    'tenant-dashboard-live',
    ()=>getTenantDashboardLive(slug),
    emptyLiveSnapshot
  );
  const timeZone=live?.tenant?.timezone||'Asia/Riyadh';
  const requestedRange=resolveDashboardRange(query,{timeZone});
  const range=canReadCrm
    ?requestedRange
    :resolveDashboardRange({period:'this_month'},{timeZone});
  const shouldLoadAchievement=!EXECUTIVE_ROLES.has(membershipRole);
  const [dashboard,achievement,marketing]=await Promise.all([
    optionalServerRead(
      'tenant-role-dashboard',
      ()=>getTenantRoleDashboard(slug,range.from,range.to),
      null
    ),
    shouldLoadAchievement
      ?optionalServerRead(
        'tenant-achievement-dashboard',
        ()=>getTenantEmployeeAchievement(slug),
        null
      )
      :Promise.resolve(null),
    canReadMarketing
      ?getOptionalMarketing(slug,range)
      :Promise.resolve(null)
  ]);
  const resolvedRole=dashboard?.viewer?.roleKey
    ||achievement?.viewer?.roleKey
    ||membershipRole;
  const showAchievement=!EXECUTIVE_ROLES.has(resolvedRole);

  return <>
    {showAchievement&&<AchievementBoard achievement={achievement}/>}
    <RoleDashboard
      slug={slug}
      dashboard={dashboard||unavailableDashboard(membership)}
      operations={live}
      marketing={marketing}
      canReadMarketing={canReadMarketing}
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
      fallbackRoleKey={membershipRole}
      range={range}
    />
  </>;
}
