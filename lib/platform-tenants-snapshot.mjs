export function mergePlatformTenantsSnapshot(base,manager){
  const byTenant=new Map((manager?.tenants||[]).map(item=>[item.tenantId,item]));
  const available=manager!==null&&(base.tenants||[]).every(tenant=>byTenant.has(tenant.id));
  return {
    ...base,
    odeiryManager:{
      available,
      globalEnabled:available?Boolean(manager.globalEnabled):null,
      canManage:available&&Boolean(manager.canManage)
    },
    tenants:(base.tenants||[]).map(tenant=>{
      const state=byTenant.get(tenant.id);
      return {...tenant,odeiryManager:state?{
        available:true,
        enabled:Boolean(state.enabled),
        effectiveEnabled:Boolean(state.effectiveEnabled),
        version:Number(state.version)||0
      }:{available:false,enabled:null,effectiveEnabled:null,version:null}};
    })
  };
}
