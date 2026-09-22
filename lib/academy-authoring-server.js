import {trainingRpc} from './training-server';
import {authoringSnapshotOptions} from './academy-authoring.mjs';
import {TRAINING_PILOT_SLUG,trainingProblem} from './training-request.mjs';

export async function getAcademyAuthoringSnapshot(slug,input={}){
  if(slug!==TRAINING_PILOT_SLUG)throw trainingProblem('academy_authoring_not_available',404);
  const options=authoringSnapshotOptions(input);
  return trainingRpc('v1_academy_authoring_snapshot',{p_slug:slug,p_course_id:options.courseId,p_path_id:options.pathId,p_offset:options.offset,p_query:options.query,p_path_offset:options.pathOffset});
}

export async function getAcademyLearnerPaths(slug,input={}){
  if(slug!==TRAINING_PILOT_SLUG)throw trainingProblem('academy_authoring_not_available',404);
  const {offset}=authoringSnapshotOptions(input);
  return trainingRpc('v1_academy_learner_paths',{p_slug:slug,p_offset:offset});
}
