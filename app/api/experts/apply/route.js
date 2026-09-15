import {readServiceBody,serviceRpc,serviceJson,serviceFailure} from '../../../../lib/service-hub-http';
import {validateExpertApplication} from '../../../../lib/service-hub.mjs';
export async function POST(request){try{
  const body=await readServiceBody(request);
  if(body.website)return serviceJson({success:true});
  let payload;try{payload=validateExpertApplication(body);}catch(error){return serviceJson({error:error.message},400);}
  await serviceRpc('v1_public_expert_application',{p_payload:payload},{publicAccess:true});
  return serviceJson({success:true});
}catch(error){return serviceFailure(error);}}
