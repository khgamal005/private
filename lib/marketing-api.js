import {authRpc} from './server-auth';
import {unstable_rethrow} from 'next/navigation';

export async function getTenantMarketingHub(slug,{
  from=null,
  to=null,
  monthToDate=false
}={}){
  const snapshotPromise=monthToDate
    ?authRpc(
      'v3_tenant_marketing_month_snapshot',
      {p_slug:slug},
      {timeoutMs:12000}
    )
    :authRpc('v2_tenant_marketing_hub_snapshot',{
      p_slug:slug,
      p_from:from,
      p_to:to
    },{timeoutMs:12000});
  const [data,schedules]=await Promise.all([
    snapshotPromise,
    authRpc(
      'v2_tenant_sync_schedule_snapshot',
      {p_slug:slug},
      {retryTransient:true,timeoutMs:8000}
    )
      .catch(error=>{
        unstable_rethrow(error);
        return null;
      })
  ]);
  const marketing=schedules?.marketing||{};
  return {
    ...data,
    rangeMode:monthToDate?'month_to_date':'date_range',
    range:{
      ...(data?.range||{}),
      timeZone:data?.range?.timeZone
        ||data?.range?.timezone
        ||data?.settings?.timezone
        ||null
    },
    providers:(data?.providers||[]).map(provider=>({
      ...provider,
      connection:provider.connection&&marketing[provider.providerKey]
        ?{...provider.connection,...marketing[provider.providerKey]}
        :provider.connection
    }))
  };
}
