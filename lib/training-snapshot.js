import {TRAINING_PILOT_ID,TRAINING_PILOT_SLUG,TRAINING_ROLES,validTrainingId,trainingProblem} from './training-request.mjs';
import {trainingRpc} from './training-server';

export async function getTrainingSnapshot(slug,options={}){
  if(slug!==TRAINING_PILOT_SLUG)throw trainingProblem('training_not_available',404);
  const role=options.role||'learner';
  if(!TRAINING_ROLES.has(role))throw trainingProblem('invalid_request');
  const offset=options.offset===undefined?0:Number(options.offset);
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw trainingProblem('invalid_request');
  for(const key of ['enrollmentId','courseId'])if(options[key]!==undefined&&options[key]!==null&&!validTrainingId(options[key]))throw trainingProblem('invalid_request');
  // Manager-only data is never fetched for a learner or an assigned instructor.
  const operations=role==='manager'?await trainingRpc('v1_tenant_training_journey_snapshot',{p_slug:slug,p_offset:offset}):null;
  if(operations?.capabilities?.canConfigureAutomation){
    operations.automation=await trainingRpc('v3_training_automation_settings_action',{p_slug:slug,p_action:'snapshot',p_payload:{}});
  }
  const learning=operations?.enabled===false||(role==='manager'&&operations?.capabilities?.canManageLearning===false)?null:await trainingRpc('v1_training_learning_snapshot',{
    p_tenant_slug:slug,p_role:role,p_enrollment_id:options.enrollmentId||null,p_course_id:options.courseId||null,p_offset:offset
  });
  return {
    role,tenant:{id:TRAINING_PILOT_ID,slug:TRAINING_PILOT_SLUG,name:'مركز ماركتون',timezone:operations?.settings?.timezone||'Asia/Riyadh',currency:'SAR'},
    viewer:{...(learning?.viewer||{}),...(operations?.capabilities||{}),capabilities:operations?.capabilities||{}},learning,operations
  };
}
