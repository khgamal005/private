import {notFound} from 'next/navigation';
import AchievementBoard from '../../../components/achievement-board';
import RoleDashboard from '../../../components/role-dashboard';
import {
  getTenant,
  getTenantOperations,
  getTenantRoleDashboard
} from '../../../lib/api';
import {getTenantEmployeeAchievement} from '../../../lib/achievement';
import {requireTenantPermission} from '../../../lib/server-auth';

export const dynamic='force-dynamic';

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
  const canReadCrm=Boolean(
    context.platformAccess||permissions.includes('tenant.crm.read')
  );
  const [data,operations,dashboard,achievement]=await Promise.all([
    getTenant(slug),
    getTenantOperations(slug,{includeSales:canReadCrm}),
    getTenantRoleDashboard(slug).catch(()=>null),
    getTenantEmployeeAchievement(slug).catch(()=>null)
  ]);
  if(!data)return notFound();

  return <>
    <AchievementBoard achievement={achievement}/>
    <RoleDashboard
      slug={slug}
      dashboard={dashboard||unavailableDashboard(membership)}
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
    />
  </>;
}
