import {notFound,unstable_rethrow} from 'next/navigation';
import AchievementBoard from '../../../components/achievement-board';
import RoleDashboard from '../../../components/role-dashboard';
import {getTenantMarketingHub} from '../../../lib/marketing-api';
import {
  getTenant,
  getTenantOperations,
  getTenantRoleDashboard
} from '../../../lib/api';
import {getTenantEmployeeAchievement} from '../../../lib/achievement';
import {resolveDashboardRange} from '../../../lib/reporting';
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';
const EXECUTIVE_ROLES=new Set([
  'tenant_owner',
  'tenant_admin',
  'executive_manager'
]);

async function getOptionalMarketing(slug,range){
  try{
    return await getTenantMarketingHub(slug,{
      from:range.from,
      to:range.to
    });
  }catch(error){
    unstable_rethrow(error);
    return null;
  }
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
  const [context,data]=await Promise.all([
    requireTenantPermission(slug,'tenant.workspace.read'),
    getTenant(slug)
  ]);
  if(!data)return notFound();
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
  const timeZone=data.tenant?.timezone||data.timezone||'UTC';
  const requestedRange=resolveDashboardRange(query,{timeZone});
  const range=canReadCrm
    ?requestedRange
    :resolveDashboardRange({period:'this_month'},{timeZone});
  const shouldLoadAchievement=!EXECUTIVE_ROLES.has(membershipRole);
  const [operations,dashboard,achievement,marketing]=await Promise.all([
    getTenantOperations(slug,{includeSales:canReadCrm}),
    getTenantRoleDashboard(slug,range.from,range.to).catch(()=>null),
    shouldLoadAchievement
      ?getTenantEmployeeAchievement(slug).catch(()=>null)
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
      operations={operations}
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
