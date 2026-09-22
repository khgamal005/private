import {createHash} from 'node:crypto';
import {readTrainingBody,validateTrainingRequest,validTrainingId,validTrainingToken,LEARNING_ACTIONS,JOURNEY_ACTIONS,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingFailure,trainingRpc} from '../../../../lib/training-server';
import {getTrainingSnapshot} from '../../../../lib/training-snapshot';
import {academyAccessAllowed,academyTrainingPermission} from '../../../../lib/academy-policy.mjs';

export const dynamic='force-dynamic';

export async function POST(request,{params}){
  try{
    const {action}=await params;
    const academyRequestAction=['academy_create_request','academy_decide_request'].includes(action);
    const automationAction=['automation_settings','automation_preview'].includes(action);
    if(action!=='snapshot'&&!academyRequestAction&&!automationAction&&!LEARNING_ACTIONS.has(action)&&!JOURNEY_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:action==='save_draft'?1048576+4096:action==='submit_assignment'?210000:24576});
    const {tenantSlug,commandId,payload,workspace}=validateTrainingRequest(body,{mutation:!['snapshot','automation_preview'].includes(action)});
    if(action==='snapshot'){
      const snapshotOptions={...payload};delete snapshotOptions.workspace;
      return trainingJson(await getTrainingSnapshot(tenantSlug,{...snapshotOptions,...(workspace?{workspace}:{})}));
    }
    if(academyRequestAction&&workspace!=='academy')throw trainingProblem('invalid_request');
    const academyLearnerRequest=workspace==='academy'&&action==='create_request';
    if(workspace==='academy'&&(automationAction||(JOURNEY_ACTIONS.has(action)&&!academyLearnerRequest))){
      // Operations writes retain their original Odeir authorization boundary.
      const access=await trainingRpc('v1_academy_workspace_snapshot',{p_slug:tenantSlug});
      if(!academyAccessAllowed(access,tenantSlug,{requiredComponent:'lms'})||access.odeirAccess!==true||access.mode!=='connected')throw trainingProblem('forbidden',403);
    }
    if(workspace==='academy'&&academyTrainingPermission(action)){
      const access=await trainingRpc('v1_academy_workspace_snapshot',{p_slug:tenantSlug});
      if(!academyAccessAllowed(access,tenantSlug,{requiredComponent:'lms',permission:academyTrainingPermission(action)}))throw trainingProblem('forbidden',403);
    }
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
    delete safePayload.actorSubjectId;delete safePayload.role;delete safePayload.workspace;
    if(action==='issue_invitation'){
      if(!validTrainingToken(payload.invitationToken))throw trainingProblem('invalid_invitation');
      invitationToken=payload.invitationToken;
      safePayload.tokenHash=createHash('sha256').update(invitationToken).digest('hex');
    }
    delete safePayload.invitationToken;
    if(academyRequestAction){
      delete safePayload.assignedStaffId;delete safePayload.dueAt;
      return trainingJson(await trainingRpc('v1_academy_request_action',{p_slug:tenantSlug,p_action:action==='academy_create_request'?'create_request':'decide_request',p_command_id:commandId,p_payload:safePayload}));
    }
    const result=LEARNING_ACTIONS.has(action)||academyLearnerRequest
      ?await trainingRpc(workspace==='academy'?'v1_academy_training_action':'v1_training_learning_action',{[workspace==='academy'?'p_slug':'p_tenant_slug']:tenantSlug,p_action:action,p_command_id:commandId,p_payload:safePayload})
      :await trainingRpc('v1_tenant_training_journey_action',{p_slug:tenantSlug,p_action:action,p_payload:{...safePayload,commandId}});
    return trainingJson(invitationToken?{...result,invitationUrl:`/training/accept${workspace==='academy'?`?tenant=${encodeURIComponent(tenantSlug)}&workspace=academy`:''}#${invitationToken}`} : result);
  }catch(error){return trainingFailure(error);}
}
