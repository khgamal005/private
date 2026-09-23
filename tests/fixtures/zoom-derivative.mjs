import {zoomSetup,call,id,T,COURSE,ADMIN,service} from './zoom-database.mjs';
import {configure} from './academy-platform-database.mjs';
import {seedZoomLesson} from './zoom-lesson.mjs';
export async function seedZoomDerivative({published=true}={}){
 const db=await zoomSetup({complete:true});
 try{
  const lesson=await seedZoomLesson(db);
  await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid) values($1,$2,$3,$4,'retention-instance')",[lesson.instance,T,lesson.connection,lesson.link]);
  const recordingId=id(97001),draftId=id(97002);
  await db.query("insert into zoom_core.recordings(id,tenant_id,instance_id,provider_file_id,file_type,transcript,transcript_revision) values($1,$2,$3,'isolated-retention','TRANSCRIPT','WEBVTT synthetic source',1)",[recordingId,T,lesson.instance]);
  // Synthetic completed generation. Real Odeiry reservation/finalization is
  // exercised in zoom-advanced; this fixture targets authoring deletion only.
  await db.query("insert into zoom_core.ai_drafts(id,tenant_id,recording_id,source_revision,source_hash,requested_by,kind,state,content) values($1,$2,$3,1,'synthetic-source',$4,'summary','draft','{}')",[draftId,T,recordingId,ADMIN]);
  await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.zoom.ai.generate') on conflict do nothing",[id(21)]);
  await db.query("update zoom_core.settings set retention_policy='{\"approved\":true,\"days\":30}' where tenant_id=$1",[T]);
  await configure(db,{components:{lms:true,website:false,store:false}});
  await db.query('insert into academy.authoring_settings(tenant_id,enabled) values($1,true)',[T]);
  const document=await call(db,'private_app.academy_authoring_blank_v1',{p_title:'Synthetic retention course',p_category:'Training'});
  document.policy={minAttendancePercent:0,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:true,termsVersion:'test-v1',supportEmail:'support@example.test'};
  document.topics=[{id:'human-topic',title:'Independent human topic',summary:'Preserve this',units:[{id:'human-unit',title:'Independent human lesson',kind:'text',required:true,minimumSeconds:0,body:'Independent human material'}]},
   {id:'assessment',title:'Independent assessment',summary:'',units:[{id:'quiz',title:'Human quiz',kind:'quiz',required:true,questions:[{id:'q1',prompt:'Choose one',options:['Correct','Wrong'],correctOptionIndex:0}]}]}];
  await authoring(db,'save_course',{courseId:COURSE,expectedRevision:0,document},97003);
  const applyArgs={p_slug:'marktone',p_command_id:id(97004),p_payload:{draftId,courseId:COURSE,expectedVersion:1,title:'SENSITIVE SOURCE TITLE',body:'SENSITIVE SOURCE BODY',reviewed:true}};
  const applied=await call(db,'public.v1_zoom_ai_apply',applyArgs);
  let versionId;
  if(published)versionId=(await authoring(db,'publish_course',{courseId:COURSE,expectedRevision:applied.revision,humanReviewed:true},97005)).versionId;
  return {db,draftId,recordingId,versionId,applyArgs,applied,...lesson};
 }catch(error){await db.close();delete error.query;throw error;}
}
export const authoring=(db,p_action,p_payload,n)=>call(db,'public.v1_academy_authoring_action',{p_slug:'marktone',p_action,p_payload,p_command_id:id(n)});
export async function revokeSource(db,connection){
 await service(db);await db.query("update zoom_core.connections set status='deauthorized' where id=$1",[connection]);await call(db,'public.v1_zoom_purge',{});await service(db,false);
}
export const derivativePreview=(db,draftId)=>call(db,'public.v1_zoom_derivative_preview',{p_slug:'marktone',p_draft_id:draftId});
export const derivativeDelete=(db,preview,command=97006)=>call(db,'public.v1_zoom_derivative_delete',{p_slug:'marktone',p_command_id:id(command),p_payload:{draftId:preview.draftId,previewHash:preview.previewHash,reviewed:true,reason:'Approved synthetic source deletion'}});
