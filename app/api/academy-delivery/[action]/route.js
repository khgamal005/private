import {readTrainingBody,validTrainingId,TRAINING_PILOT_SLUG,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {courseDeliveryPayload} from '../../../../lib/academy-delivery.mjs';
import {academyCommerceError} from '../../../../lib/academy-commerce-policy.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}) {
  try {
    const {action}=await params;
    if(!['snapshot','save_offer','publish_offer','assign_instructor','create_run'].includes(action))throw trainingProblem('not_found',404);
    const body=await readTrainingBody(request,{maxBytes:16384});
    if(body.tenantSlug!==TRAINING_PILOT_SLUG)throw trainingProblem('invalid_request');
    const payload=courseDeliveryPayload(action,body.payload);
    if(action==='snapshot')return trainingJson(await trainingRpc('v1_academy_course_delivery_snapshot',{p_slug:body.tenantSlug,p_course_id:payload.courseId}));
    if(!validTrainingId(body.commandId))throw trainingProblem('invalid_request');
    return trainingJson(await trainingRpc('v1_academy_course_delivery_action',{p_slug:body.tenantSlug,p_action:action,p_command_id:body.commandId,p_payload:payload}));
  }catch(error){return trainingJson({error:academyCommerceError(error?.code)},error?.status||400);}
}
