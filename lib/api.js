import {authRpc} from './server-auth';

export async function getControl(){
  const [base,provisioning]=await Promise.all([
    authRpc('v2_platform_control_snapshot'),
    authRpc('v2_platform_provisioning_snapshot')
  ]);
  const tenantDetails=new Map((provisioning.tenants||[]).map(item=>[item.tenantId,item]));
  return {
    ...base,
    pendingInvitations:provisioning.pendingInvitations||0,
    invitations:provisioning.invitations||[],
    tenants:(base.tenants||[]).map(tenant=>{
      const details=tenantDetails.get(tenant.id)||{};
      return {
        ...tenant,
        ...details,
        employees:details.memberCount??tenant.employees??0
      };
    })
  };
}

export async function getTenant(slug){
  const [workspace,access]=await Promise.all([
    authRpc('v2_tenant_workspace_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_access_snapshot',{p_slug:slug})
  ]);
  return {...workspace,...access};
}
