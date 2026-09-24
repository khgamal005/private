import {randomBytes,createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {readTrainingBody,validTrainingId} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';
import {zoomGateway} from '../../../../lib/zoom-server';
import {zoomSnapshot} from '../../../../lib/zoom-snapshot';
import {ZOOM_ACTIONS,ZOOM_PROVIDER_ACTIONS,ZOOM_REVIEWS,zoomPayload,zoomErrorMessage,zoomErrorStatus} from '../../../../lib/zoom-contract.mjs';
import {reportCsv} from '../../../../supabase/functions/_shared/zoom-evidence.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}){
 try{
  const {action}=await params;if(!ZOOM_ACTIONS.has(action))return trainingJson({error:'الإجراء غير موجود.'},404);
  const body=await readTrainingBody(request,{maxBytes:32768});const tenantSlug=body.tenantSlug;
  if(typeof tenantSlug!=='string'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(tenantSlug))return trainingJson({error:'راجع بيانات الطلب.'},400);
  const payload=zoomPayload(body.payload||{});
  if(action==='snapshot')return trainingJson(await zoomSnapshot(tenantSlug,payload.view||'sessions',payload));
  if(action==='setup')return trainingJson(await zoomGateway('setup',{tenantSlug}));
  if(action==='report_ticket'){const token=randomBytes(32).toString('hex');const result=await trainingRpc('v1_zoom_report_ticket',{p_slug:tenantSlug,p_export_id:payload.exportId,p_token_hash:createHash('sha256').update(token).digest('hex')});return trainingJson({...result,path:`/api/zoom/reports/${payload.exportId}?tenant=${encodeURIComponent(tenantSlug)}&token=${token}`});}
  if(action==='webinar_snapshot')return trainingJson(await trainingRpc('v1_zoom_webinar_snapshot',{p_slug:tenantSlug,p_link_id:payload.linkId,p_offset:payload.offset||0}));
  if(action==='derivative_snapshot')return trainingJson(await trainingRpc('v1_zoom_derivative_snapshot',{p_slug:tenantSlug,p_offset:payload.offset||0}));
  if(action==='derivative_preview')return trainingJson(await trainingRpc('v1_zoom_derivative_preview',{p_slug:tenantSlug,p_draft_id:payload.draftId}));
  if(action==='ai_snapshot')return trainingJson(await trainingRpc('v1_zoom_ai_snapshot',{p_slug:tenantSlug,p_recording_id:payload.recordingId}));
  if(action==='preview')return trainingJson(await trainingRpc('v1_zoom_assignment_preview',{p_slug:tenantSlug,p_session_id:payload.sessionId,p_payload:payload}));
  if(action==='recording_access')return trainingJson(await trainingRpc('v1_zoom_recording_access',{p_slug:tenantSlug,p_recording_id:payload.recordingId,p_enrollment_id:payload.enrollmentId||null}));
  if(action==='export'){
   const result=await trainingRpc('v1_zoom_export',{p_slug:tenantSlug,p_options:payload});
   const rows=[['المحاضرة','الموعد','الحالة','المضيف','الحساب','المطلوب حضورهم'],...result.rows.map(r=>[r.title,r.starts_at,r.state,r.host_name,r.account_name,r.expected_learners])];
   return new Response(reportCsv(rows),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="odeir-zoom-report.csv"','cache-control':'private, no-store','referrer-policy':'no-referrer'}});
  }
  if(ZOOM_PROVIDER_ACTIONS.has(action))return trainingJson(await zoomGateway(action,{tenantSlug,...payload}));
  if(!validTrainingId(body.commandId))return trainingJson({error:'تعذر تحديد العملية.'},400);
  if(action==='initialize')return trainingJson(await trainingRpc('v1_zoom_initialize',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='activate')return trainingJson(await zoomGateway('activate',{tenantSlug,commandId:body.commandId,expectedVersion:payload.expectedVersion,confirmed:payload.confirmed}));
  if(action==='webinar_prepare'||action==='webinar_configure')return trainingJson(await trainingRpc('v1_zoom_webinar_action',{p_slug:tenantSlug,p_action:action,p_command_id:body.commandId,p_payload:payload}));
  if(action==='ai_generate'){
   const {generateZoomDraft}=await import('../../../../lib/zoom-ai.mjs');const {runZoomLearningAgent}=await import('../../../../lib/zoom-ai-agent.js');const {finalizeOdeiryRun,hasOdeiryServiceCredential}=await import('../../../../lib/odeiry-service-rpc.js');
   return trainingJson(await generateZoomDraft({slug:tenantSlug,commandId:body.commandId,payload,rpc:trainingRpc,finalize:finalizeOdeiryRun,generate:runZoomLearningAgent,configured:!!process.env.OPENAI_API_KEY&&hasOdeiryServiceCredential()}));
  }
  if(action==='derivative_delete')return trainingJson(await trainingRpc('v1_zoom_derivative_delete',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='ai_apply'||action==='ai_policy')return trainingJson(await trainingRpc(action==='ai_apply'?'v1_zoom_ai_apply':'v1_zoom_ai_policy',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='replacement_retry')return trainingJson(await trainingRpc('v1_zoom_replacement_retry',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='replace')return trainingJson(await trainingRpc('v1_zoom_replace',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='poll')return trainingJson(await trainingRpc('v1_zoom_poll',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='webinar_notify')return trainingJson(await trainingRpc('v1_zoom_webinar_notify',{p_slug:tenantSlug,p_command_id:body.commandId,p_registration_id:payload.registrationId}));
  if(action==='report_request')return trainingJson(await trainingRpc('v1_zoom_report_request',{p_slug:tenantSlug,p_command_id:body.commandId,p_options:payload}));
  if(action==='series')return trainingJson(await trainingRpc('v1_zoom_series',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='batch')return trainingJson(await trainingRpc('v1_zoom_batch',{p_slug:tenantSlug,p_command_id:body.commandId,p_sessions:payload.sessions}));
  if(action==='map_instance'||action==='retention_policy')return trainingJson(await trainingRpc(action==='map_instance'?'v1_zoom_map_instance':'v1_zoom_retention_policy',{p_slug:tenantSlug,p_command_id:body.commandId,p_payload:payload}));
  if(action==='issue_invitation'){
   const token=randomBytes(32).toString('hex');const result=await trainingRpc('v1_zoom_invitation',{p_slug:tenantSlug,p_action:'issue_invitation',p_command_id:body.commandId,p_payload:{enrollmentId:payload.enrollmentId,tokenHash:createHash('sha256').update(token).digest('hex')}});
   return trainingJson({...result,path:`/training/accept?workspace=zoom&tenant=${encodeURIComponent(tenantSlug)}#${token}`});
  }
  if(action==='connect'){
   const state=randomBytes(32).toString('hex');
   const result=await zoomGateway('start',{tenantSlug,state,mode:payload.mode||'add',connectionId:payload.connectionId||null});
   (await cookies()).set('odeir_zoom_oauth',JSON.stringify({state,tenantSlug}),{httpOnly:true,secure:true,sameSite:'lax',path:'/api/zoom',maxAge:600});
   return trainingJson(result);
  }
  const fn=ZOOM_REVIEWS.has(action)?'v1_zoom_review':['publish_recording','withdraw_recording'].includes(action)?'v1_zoom_recording_action':action==='settings'?'v1_zoom_settings':'v1_zoom_action';
  return trainingJson(await trainingRpc(fn,{p_slug:tenantSlug,...(action==='settings'?{}:{p_action:action}),p_command_id:body.commandId,p_payload:payload}));
 }catch(error){const code=error?.code||error?.message;return trainingJson({error:zoomErrorMessage(code),code:/^zoom_[a-z_]{1,80}$/.test(code||'')?code:'zoom_request_failed'},error?.status||zoomErrorStatus(code||''));}
}
