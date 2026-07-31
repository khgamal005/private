import {authRpc} from './server-auth';

export async function getTenantCommerceHub(slug){
  return authRpc('v2_tenant_commerce_hub_snapshot',{p_slug:slug});
}
