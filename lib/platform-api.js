import {authRpc} from './server-auth';

function permissionDenied(error){
  const detail=error instanceof Error?error.message:String(error||'');
  return detail.includes(': 403 ')
    ||detail.includes('forbidden')
    ||detail.includes('permission denied');
}

async function optionalRpc(name,body,fallback){
  try{
    return await authRpc(name,body,{redirectForbidden:false});
  }catch(error){
    if(permissionDenied(error))return fallback;
    throw error;
  }
}

export async function getPlatformControl(){
  const [base,provisioning,addonCenter,commerce]=await Promise.all([
    authRpc('v3_platform_control_snapshot'),
    optionalRpc('v2_platform_provisioning_snapshot_v2',{},
      {pendingInvitations:0,invitations:[],tenants:[]}),
    optionalRpc('v2_platform_addon_center_snapshot',{},
      {summary:{},products:[],subscriptions:[]}),
    optionalRpc('v4_platform_commerce_snapshot',{},
      {summary:{},plans:[],subscriptions:[],orders:[],payments:[]})
  ]);

  const tenantDetails=new Map((provisioning.tenants||[]).map(item=>[
    item.tenantId,
    item
  ]));

  return {
    ...base,
    addonCenter,
    commerce,
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

export async function getPlatformAccess(){
  return authRpc('v2_platform_access_snapshot');
}
