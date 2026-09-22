import {TRAINING_PILOT_ID,TRAINING_PILOT_SLUG,TRAINING_ROLES,validTrainingId,trainingProblem} from './training-request.mjs';
import {trainingRpc} from './training-server';
import {academyAccessAllowed,validAcademySlug} from './academy-policy.mjs';

export async function getTrainingSnapshot(slug,options={}){
  const academy=options.workspace==='academy';
  if(options.workspace!==undefined&&!academy)throw trainingProblem('invalid_request');
  if(academy?!validAcademySlug(slug):slug!==TRAINING_PILOT_SLUG)throw trainingProblem('training_not_available',404);
  const role=options.role||'learner';
  if(!TRAINING_ROLES.has(role))throw trainingProblem('invalid_request');
  const offset=options.offset===undefined?0:Number(options.offset);
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw trainingProblem('invalid_request');
  for(const key of ['enrollmentId','courseId'])if(options[key]!==undefined&&options[key]!==null&&!validTrainingId(options[key]))throw trainingProblem('invalid_request');
  if(academy){
    const access=role==='manager'?await trainingRpc('v1_academy_workspace_snapshot',{p_slug:slug}):null;
    const managesLearning=access?.permissions?.manageLearning===true;
    const connected=access?.mode==='connected'&&access?.odeirAccess===true;
    const managesRequests=access?.mode==='standalone'&&access?.permissions?.manageAdmissions===true;
    const operates=connected&&(access?.permissions?.manageAdmissions===true||access?.permissions?.verifyPayments===true);
    if(access&&(!academyAccessAllowed(access,slug,{requiredComponent:'lms'})||(!managesLearning&&!operates&&!managesRequests)))throw trainingProblem('forbidden',403);
    // All reads below share the authenticated caller and enforce their own SQL
    // permission boundary. Parallelize them after resolving workspace access.
    const operationsPromise=role==='manager'&&connected&&slug===TRAINING_PILOT_SLUG
      ?trainingRpc('v1_tenant_training_journey_snapshot',{p_slug:slug,p_offset:offset}).catch(error=>{
        if(!/forbidden|permission|not_enabled|not_available|disabled/.test(error?.code||''))throw error;
        return null;
      }):Promise.resolve(null);
    const [operations,learning,requestQueue,learningPaths]=await Promise.all([
      operationsPromise,
      role!=='manager'||managesLearning?trainingRpc('v1_academy_training_snapshot',{p_slug:slug,p_role:role,p_enrollment_id:options.enrollmentId||null,p_course_id:options.courseId||null,p_offset:offset}):null,
      role==='manager'&&access?.mode==='standalone'&&(managesLearning||managesRequests)?trainingRpc('v1_academy_request_snapshot',{p_slug:slug,p_role:'manager',p_offset:offset}):null,
      role==='learner'&&slug===TRAINING_PILOT_SLUG?trainingRpc('v1_academy_learner_paths',{p_slug:slug,p_offset:0}):null
    ]);
    if(role==='manager'&&!managesLearning&&!operations&&!managesRequests)throw trainingProblem('forbidden',403);
    if(requestQueue){requestQueue.pageSize=requestQueue.limit||50;requestQueue.hasMore=(requestQueue.requests?.length||0)>=requestQueue.pageSize;}
    const tenant=access?.tenant||learning?.tenant;
    if(!tenant?.id||tenant.slug!==slug)throw trainingProblem('training_not_available',404);
    return {role,workspace:'academy',mode:access?.mode||learning?.mode,permissions:access?.permissions||{},tenant,requestQueue,learningPaths,
      viewer:{...(learning?.viewer||{}),...(operations?.capabilities||{}),canManageLearning:managesLearning,canConfigureAutomation:false,canReadAdmissions:access?.permissions?.manageAdmissions===true,canReadAccounting:access?.permissions?.verifyPayments===true,capabilities:operations?.capabilities||{}},learning,operations};
  }
  // Manager-only data is never fetched for a learner or an assigned instructor.
  const operations=role==='manager'?await trainingRpc('v1_tenant_training_journey_snapshot',{p_slug:slug,p_offset:offset}):null;
  if(operations?.enabled===true&&operations?.capabilities?.canConfigureAutomation){
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
