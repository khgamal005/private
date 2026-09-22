import {createHash} from 'node:crypto';
import {readTrainingBody,validTrainingId,validTrainingToken,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {validAcademySlug} from '../../../../lib/academy-policy.mjs';
import {PUBLIC_STORE_ACTIONS,PRIVATE_STORE_ACTIONS,academyCommerceError} from '../../../../lib/academy-commerce-policy.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}){
 try{
  const {action}=await params;
  const publicAccess=PUBLIC_STORE_ACTIONS.has(action);
  if(!publicAccess&&!PRIVATE_STORE_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
  const body=await readTrainingBody(request,{maxBytes:28000});
  if(!validAcademySlug(body.tenantSlug)||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw trainingProblem('invalid_request');
  if(!['snapshot','view_order','report_transfer'].includes(action)&&!validTrainingId(body.commandId))throw trainingProblem('invalid_request');
  const payload={...body.payload};
  delete payload.actorSubjectId;delete payload.tenantId;delete payload.tenantSlug;delete payload.subjectId;
  if(action==='snapshot'){
   const offset=Number(payload.offset||0);
   if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw trainingProblem('invalid_request');
   return trainingJson(await trainingRpc('v1_academy_commerce_snapshot',{p_slug:body.tenantSlug,p_offset:offset}));
  }
  if(publicAccess){
   if(!validTrainingToken(payload.accessToken))throw trainingProblem('invalid_request');
   payload.tokenHash=createHash('sha256').update(payload.accessToken).digest('hex');delete payload.accessToken;
   if(action!=='create_order'&&!validTrainingId(payload.orderId))throw trainingProblem('invalid_request');
  }
  return trainingJson(await trainingRpc(publicAccess?'v1_academy_store_order':'v1_academy_commerce_action',{
   p_slug:body.tenantSlug,p_action:action==='view_order'?'view':action,p_command_id:validTrainingId(body.commandId)?body.commandId:null,p_payload:payload
  },{publicAccess}));
 }catch(error){return trainingJson({error:academyCommerceError(error?.code),retryable:error?.code==='network_unavailable'},error?.code==='academy_rate_limited'?429:error?.status||400);}
}
