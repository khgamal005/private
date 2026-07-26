import {authRpc} from './server-auth';
export const getControl=()=>authRpc('v2_platform_control_snapshot');
export const getTenant=slug=>authRpc('v2_tenant_workspace_snapshot',{p_slug:slug});
