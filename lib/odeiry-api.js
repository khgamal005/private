import 'server-only';

import {authRpc} from './server-auth';
import {parseOdeiryManagerCapability} from './odeiry-manager-contract.mjs';

const UNAVAILABLE={
  available:false,
  enabled:false,
  mode:null,
  manager:{
    allowed:false,globalEnabled:false,enabled:false,
    reviewAvailable:false,available:false
  }
};

export async function getTenantOdeirySnapshot(slug){
  const normalizedSlug=String(slug??'').trim().toLowerCase();
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)){
    return UNAVAILABLE;
  }
  const snapshot=await authRpc(
    'v3_tenant_odeiry_snapshot',
    {p_slug:normalizedSlug},
    {retryTransient:true,timeoutMs:5000,redirectForbidden:false}
  );
  const mode=['tenant_member','platform_operator'].includes(snapshot?.mode)
    ?snapshot.mode
    :null;
  const manager=parseOdeiryManagerCapability(snapshot);
  return {
    available:snapshot?.available===true,
    enabled:snapshot?.enabled===true,
    mode,
    manager:{
      allowed:manager.allowed,
      globalEnabled:manager.globalEnabled,
      enabled:manager.enabled,
      reviewAvailable:manager.reviewAvailable,
      available:manager.available
    }
  };
}
