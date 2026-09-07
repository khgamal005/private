import {authRpc} from './server-auth';

export async function getTenantMarketplaceV2(slug){
  return authRpc('v4_tenant_marketplace_snapshot',{p_slug:slug});
}

export async function getPlatformBankTransfers(){
  return authRpc('v3_platform_bank_transfer_snapshot');
}


