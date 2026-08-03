import {authRpc} from './server-auth';

export async function getTenantMarketingHub(slug,{from=null,to=null}={}){
  return authRpc('v2_tenant_marketing_hub_snapshot',{
    p_slug:slug,
    p_from:from,
    p_to:to
  });
}
