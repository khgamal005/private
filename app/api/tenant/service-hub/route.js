import {readServiceBody,serviceRpc,serviceJson,serviceFailure} from '../../../../lib/service-hub-http';
export async function POST(request){try{const body=await readServiceBody(request);const data=await serviceRpc('v1_tenant_service_hub_action',{p_slug:body.slug,p_action:body.action,p_payload:body.payload||{}});return serviceJson({data});}catch(error){return serviceFailure(error);}}
