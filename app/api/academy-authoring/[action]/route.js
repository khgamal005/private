import {readTrainingBody,validTrainingId,trainingProblem,TRAINING_PILOT_SLUG} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {AUTHORING_ACTIONS,authoringPayload,authoringErrorMessage} from '../../../../lib/academy-authoring.mjs';
import {getAcademyAuthoringSnapshot,getAcademyLearnerPaths} from '../../../../lib/academy-authoring-server';

export const dynamic='force-dynamic';
export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!['snapshot','learner_paths'].includes(action)&&!AUTHORING_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:action==='save_course'?1048576:action==='save_path'?131072:32768});
    if(body.tenantSlug!==TRAINING_PILOT_SLUG)throw trainingProblem('academy_authoring_not_available',404);
    if(action==='snapshot')return trainingJson(await getAcademyAuthoringSnapshot(body.tenantSlug,body.payload??{}));
    if(action==='learner_paths')return trainingJson(await getAcademyLearnerPaths(body.tenantSlug,body.payload??{}));
    if(!validTrainingId(body.commandId))throw trainingProblem('command_id_required');
    return trainingJson(await trainingRpc('v1_academy_authoring_action',{
      p_slug:body.tenantSlug,p_action:action,p_command_id:body.commandId,p_payload:authoringPayload(action,body.payload)
    }));
  }catch(error){return trainingJson({error:authoringErrorMessage(error?.code),retryable:error?.code==='network_unavailable'},error?.status||400);}
}
