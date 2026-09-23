import {createHash} from 'node:crypto';
import {readTrainingBody,validTrainingId,trainingProblem,TRAINING_PILOT_SLUG} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {academyPeoplePayload} from '../../../../lib/academy-people.mjs';
import {academyCommerceError} from '../../../../lib/academy-commerce-policy.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}) {
 try {
  const {action}=await params;
  if(!['snapshot','add_student','invite_student','invite_instructor'].includes(action))throw trainingProblem('not_found',404);
  const body=await readTrainingBody(request,{maxBytes:12288});
  if(body.tenantSlug!==TRAINING_PILOT_SLUG)throw trainingProblem('invalid_request');
  const payload=academyPeoplePayload(action,body.payload);
  if(action==='snapshot')return trainingJson(await trainingRpc('v1_academy_people_snapshot',{p_slug:body.tenantSlug,p_query:payload.query,p_offset:payload.offset,p_kind:payload.kind}));
  if(!validTrainingId(body.commandId))throw trainingProblem('invalid_request');
  const invitationToken=payload.invitationToken;
  if(invitationToken)payload.tokenHash=createHash('sha256').update(invitationToken).digest('hex');
  delete payload.invitationToken;
  const result=await trainingRpc('v1_academy_people_action',{p_slug:body.tenantSlug,p_action:action,p_command_id:body.commandId,p_payload:payload});
  if(invitationToken)result.invitationUrl=action==='invite_instructor'?`/academy/accept?tenant=${body.tenantSlug}#${invitationToken}`:`/training/accept?tenant=${body.tenantSlug}&workspace=academy#${invitationToken}`;
  return trainingJson(result);
 }catch(error){return trainingJson({error:academyCommerceError(error?.code)},error?.status||400);}
}
