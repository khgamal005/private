import {authRpc} from './server-auth';

export async function getTenantEmployeeAchievement(slug){
  return authRpc('v2_tenant_employee_achievement_snapshot',{
    p_slug:slug
  });
}

export async function getTenantSalesTeams(slug){
  return authRpc('v2_tenant_sales_team_snapshot',{
    p_slug:slug
  });
}
