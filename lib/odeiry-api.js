import 'server-only';

import {authRpc} from './server-auth';

export async function getTenantOdeirySnapshot(slug){
  const normalizedSlug=String(slug??'').trim().toLowerCase();
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)){
    return {available:false,enabled:false};
  }
  const snapshot=await authRpc(
    'v3_tenant_odeiry_snapshot',
    {p_slug:normalizedSlug},
    {retryTransient:true,timeoutMs:5000,redirectForbidden:false}
  );
  return {
    available:snapshot?.available===true,
    enabled:snapshot?.enabled===true
  };
}
