import {authRpc} from './server-auth';

export async function getTenantCommerceHub(slug){
  const [data,schedules]=await Promise.all([
    authRpc('v2_tenant_commerce_hub_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_sync_schedule_snapshot',{p_slug:slug})
      .catch(()=>null)
  ]);
  const schedule=schedules?.woocommerce||null;
  if(!schedule)return data;
  const withSchedule=connection=>connection
    ?{...connection,...schedule}
    :connection;
  return {
    ...data,
    woocommerce:data?.woocommerce?{
      ...data.woocommerce,
      connection:withSchedule(data.woocommerce.connection)
    }:data?.woocommerce,
    providers:(data?.providers||[]).map(provider=>
      provider.providerKey==='woocommerce'
        ?{...provider,connection:withSchedule(provider.connection)}
        :provider
    )
  };
}
