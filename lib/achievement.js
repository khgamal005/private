import {authRpc} from './server-auth';

export async function getTenantEmployeeAchievement(slug){
  return authRpc('v2_tenant_employee_achievement_snapshot_v2',{
    p_slug:slug
  });
}

export async function getTenantSalesTeams(slug){
  return authRpc('v2_tenant_sales_team_snapshot',{
    p_slug:slug
  });
}

export async function getTenantStaffExtensions(slug){
  return authRpc('v2_tenant_staff_extension_snapshot',{
    p_slug:slug
  });
}
