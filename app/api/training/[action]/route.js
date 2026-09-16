import {createHash} from 'node:crypto';
import {readTrainingBody,validateTrainingRequest,validTrainingId,validTrainingToken,LEARNING_ACTIONS,JOURNEY_ACTIONS,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingFailure,trainingRpc} from '../../../../lib/training-server';
import {getTrainingSnapshot} from '../../../../lib/training-snapshot';

export const dynamic='force-dynamic';

export async function POST(request,{params}){
  try{
    const {action}=await params;
    const automationAction=['automation_settings','automation_preview'].includes(action);
    if(action!=='snapshot'&&!automationAction&&!LEARNING_ACTIONS.has(action)&&!JOURNEY_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:action==='save_draft'?1048576+4096:action==='submit_assignment'?210000:24576});
    const {tenantSlug,commandId,payload}=validateTrainingRequest(body,{mutation:!['snapshot','automation_preview'].includes(action)});
    if(action==='snapshot')return trainingJson(await getTrainingSnapshot(tenantSlug,payload));
    if(automationAction)return trainingJson(await trainingRpc('v3_training_automation_settings_action',{
      p_slug:tenantSlug,p_action:action==='automation_settings'?'update':'preview',p_payload:{...payload,commandId}
    }));
    if(action==='accept_invitation')throw trainingProblem('invalid_request'); // Dedicated auth boundary.
    let invitationToken=null;
    const safePayload={...payload};
    delete safePayload.commandId;delete safePayload.tenantId;delete safePayload.tenantSlug;
    // subjectId is a target only on instructor assignment. The actor is always
    // resolved from the caller JWT inside SQL and cannot be supplied here.
    if(action==='assign_instructor'){
      if(!validTrainingId(safePayload.subjectId))throw trainingProblem('invalid_request');
    }else delete safePayload.subjectId;
    delete safePayload.actorSubjectId;delete safePayload.role;
    if(action==='issue_invitation'){
      if(!validTrainingToken(payload.invitationToken))throw trainingProblem('invalid_invitation');
      invitationToken=payload.invitationToken;
      safePayload.tokenHash=createHash('sha256').update(invitationToken).digest('hex');
    }
    delete safePayload.invitationToken;
    const result=LEARNING_ACTIONS.has(action)
      ?await trainingRpc('v1_training_learning_action',{p_tenant_slug:tenantSlug,p_action:action,p_command_id:commandId,p_payload:safePayload})
      :await trainingRpc('v1_tenant_training_journey_action',{p_slug:tenantSlug,p_action:action,p_payload:{...safePayload,commandId}});
    return trainingJson(invitationToken?{...result,invitationUrl:`/training/accept#${invitationToken}`} : result);
  }catch(error){return trainingFailure(error);}
}
