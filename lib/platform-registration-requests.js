import {authRpc} from './server-auth';

export function getPlatformRegistrationRequests({
  status=null,
  query=null,
  offset=0,
  limit=25
}={}){
  return authRpc('v1_platform_registration_requests_snapshot',{
    p_status:status,
    p_query:query,
    p_offset:offset,
    p_limit:limit
  });
}

export function getPlatformRegistrationRequestDetail(requestId){
  return authRpc('v1_platform_registration_request_detail',{
    p_request_id:requestId
  });
}

export function getPlatformRegistrationRequestsSummary(){
  return authRpc('v1_platform_registration_requests_summary');
}
