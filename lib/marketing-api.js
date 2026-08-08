import {authRpc} from './server-auth';

export async function getTenantMarketingHub(slug,{from=null,to=null}={}){
  const [data,schedules]=await Promise.all([
    authRpc('v2_tenant_marketing_hub_snapshot',{
      p_slug:slug,
      p_from:from,
      p_to:to
    }),
    authRpc('v2_tenant_sync_schedule_snapshot',{p_slug:slug})
      .catch(()=>null)
  ]);
  const marketing=schedules?.marketing||{};
  return {
    ...data,
    providers:(data?.providers||[]).map(provider=>({
      ...provider,
      connection:provider.connection&&marketing[provider.providerKey]
        ?{...provider.connection,...marketing[provider.providerKey]}
        :provider.connection
    }))
  };
}
