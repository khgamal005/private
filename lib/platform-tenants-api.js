import {authRpc} from './server-auth';
import {optionalServerRead} from './server-resilience';
import {mergePlatformTenantsSnapshot} from './platform-tenants-snapshot.mjs';

export async function getPlatformTenants(){
  const [base,manager]=await Promise.all([
    authRpc('v1_platform_tenants_snapshot',{}, {timeoutMs:8000}),
    optionalServerRead('platform-tenants-odeiry',()=>authRpc(
      'v1_platform_odeiry_manager_snapshot',{}, {timeoutMs:4500}
    ),null)
  ]);
  return mergePlatformTenantsSnapshot(base,manager);
}
