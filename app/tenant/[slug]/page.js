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
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

async function getOptionalMarketing(slug){
  try{
    return await getTenantMarketingHub(slug,{monthToDate:true});
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
  const membershipRole=membership?.roles?.[0]||'tenant_user';
  const canReadCrm=Boolean(
    context.platformAccess||permissions.includes('tenant.crm.read')
  );
  const canReadMarketing=Boolean(
    context.platformAccess||permissions.includes('tenant.marketing.read')
  );
  const shouldLoadAchievement=membershipRole!=='tenant_owner';
  const [data,operations,dashboard,achievement,marketing]=await Promise.all([
    getTenant(slug),
    getTenantOperations(slug,{includeSales:canReadCrm}),
    getTenantRoleDashboard(slug).catch(()=>null),
    shouldLoadAchievement
      ?getTenantEmployeeAchievement(slug).catch(()=>null)
      :Promise.resolve(null),
    canReadMarketing
      ?getOptionalMarketing(slug)
      :Promise.resolve(null)
  ]);
  if(!data)return notFound();
  const resolvedRole=dashboard?.viewer?.roleKey
    ||achievement?.viewer?.roleKey
    ||membershipRole;
  const showAchievement=resolvedRole!=='tenant_owner';

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
    />
  </>;
}
