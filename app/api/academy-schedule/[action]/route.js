import {readTrainingBody,validTrainingId,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {validAcademySlug} from '../../../../lib/academy-policy.mjs';
import {SCHEDULE_ACTIONS,schedulePayload,scheduleError} from '../../../../lib/academy-schedule.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}){
 try{
  const {action}=await params;
  if(action!=='snapshot'&&!SCHEDULE_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
  const body=await readTrainingBody(request,{maxBytes:14000});
  if(!validAcademySlug(body.tenantSlug))throw trainingProblem('invalid_request');
  if(action==='snapshot'){
   const offset=body.payload?.offset??0,runId=body.payload?.runId??null;
   if(!Number.isSafeInteger(offset)||offset<0||offset>100000||(runId!==null&&!validTrainingId(runId)))throw trainingProblem('invalid_request');
   return trainingJson(await trainingRpc('v1_academy_schedule_snapshot',{p_slug:body.tenantSlug,p_run_id:runId,p_offset:offset}));
  }
  if(!validTrainingId(body.commandId))throw trainingProblem('invalid_request');
  return trainingJson(await trainingRpc('v1_academy_schedule_action',{p_slug:body.tenantSlug,p_action:action,p_command_id:body.commandId,p_payload:schedulePayload(action,body.payload)}));
 }catch(error){return trainingJson({error:scheduleError(error?.code),retryable:error?.code==='network_unavailable'},error?.status||400);}
}
