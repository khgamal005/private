import {createZoomClient,connectionAccessToken,verifiedHost,ZoomError,zoomUrl,retryDelay} from '../_shared/zoom-client.mjs';
import {sdkDecision,sdkSignature,ZOOM_SDK_VERSION} from '../_shared/zoom-sdk.mjs';
import {sha256,hmac,verifyWebhook,eventProjection} from '../_shared/zoom-evidence.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERRORS=new Set(['zoom_not_enabled','zoom_forbidden','zoom_not_found','zoom_invalid_state','zoom_account_mismatch','zoom_account_unavailable','zoom_revision_conflict','zoom_configuration_missing','zoom_scope_or_license_required','zoom_reauth_required','zoom_rate_limited','zoom_provider_unavailable','zoom_network_error','zoom_refresh_busy','zoom_access_expired','zoom_not_entitled','zoom_outside_join_window','zoom_verified_email_required','zoom_session_unavailable','zoom_host_identity_unverified','zoom_invalid_instructor','zoom_invalid_provider_response','zoom_result_incomplete','zoom_stale_lease','zoom_stale_operation','zoom_provider_review_required','zoom_transcript_unavailable','zoom_registration_pending','zoom_occurrence_required','zoom_schedule_mismatch']);
async function verifyDispatch(expected,received){if(typeof received!=='string'||received.length>512)return false;const a=await sha256(expected),b=await sha256(received);let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}
function failure(code,status=409){return Object.assign(new Error(code),{code,status});}
function publicCode(error){return SAFE_ERRORS.has(error?.code||error?.message)?error.code||error.message:'zoom_request_failed';}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});}
async function rawBody(request,max=262144){
 if(Number(request.headers.get('content-length'))>max)throw failure('zoom_payload_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw failure('zoom_invalid_request',400);
 const chunks=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>max){await reader.cancel();throw failure('zoom_payload_too_large',413);}chunks.push(part.value);}}finally{reader.releaseLock();}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder('utf8',{fatal:true}).decode(buffer);
}
export function meetingBody(link,{alternativeHosts=''}={}){
 const desired=link.desired;const minutes=Math.ceil((Date.parse(desired.endsAt)-Date.parse(desired.startsAt))/60000);
 if(!Number.isFinite(minutes)||minutes<1||minutes>1440)throw failure('zoom_invalid_schedule');
 const settings={host_video:false,participant_video:false,join_before_host:false,mute_upon_entry:true,waiting_room:true,
  approval_type:0,registration_type:1,auto_recording:desired.recording==='cloud'?'cloud':'none',registrants_email_notification:false};
 if(alternativeHosts)settings.alternative_hosts=alternativeHosts;
 return {topic:desired.title,type:link.kind==='webinar'?5:2,start_time:new Date(desired.startsAt).toISOString(),duration:minutes,timezone:'UTC',
  agenda:`ODEIR session ${link.session_id}; revision ${link.revision}`,settings};
}

export function createZoomHandler({env,fetchImpl=fetch,clientFactory=createZoomClient,now=Date.now}){
 const value=key=>typeof env==='function'?env(key):env[key];
 function client(){
  const config={clientId:value('ZOOM_CLIENT_ID'),clientSecret:value('ZOOM_CLIENT_SECRET'),redirectUri:value('ZOOM_REDIRECT_URI')};
  if(!config.clientId||!config.clientSecret||!config.redirectUri)throw failure('zoom_configuration_missing',503);
  const url=new URL(config.redirectUri);
  if(url.origin!==value('ZOOM_PUBLIC_ORIGIN')||url.pathname!=='/api/zoom/callback'||url.protocol!=='https:')throw failure('zoom_configuration_missing',503);
  return clientFactory(config,{fetchImpl,timeoutMs:12000,maxPages:5});
 }
 async function rpc(name,args,authorization,service=false){
  const key=value(service?'SUPABASE_SERVICE_ROLE_KEY':'SUPABASE_ANON_KEY');const root=value('SUPABASE_URL');
  if(!key||!root)throw failure('zoom_configuration_missing',503);
  const response=await fetchImpl(`${root}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:key,authorization:service?`Bearer ${key}`:authorization,'content-type':'application/json'},body:JSON.stringify(args)});
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw failure(SAFE_ERRORS.has(result?.message)?result.message:'zoom_forbidden',response.status===401?401:409);
  return result;
 }
 return async function handle(request){
  const action=new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
  if(request.method!=='POST')return json({error:'zoom_invalid_method'},405);
  const service=(name,args)=>rpc(name,args,'',true);
  let correlationId=crypto.randomUUID();
  try{
   if(value('ZOOM_V1_ENABLED')!=='true'&&!['webhook','dispatch'].includes(action))throw failure('zoom_not_enabled',503);
   if(!['test','production'].includes(value('ZOOM_ENVIRONMENT')))throw failure('zoom_configuration_missing',503);
   if(action==='webhook'){
    const raw=await rawBody(request);const secret=value('ZOOM_WEBHOOK_SECRET');
    if(!await verifyWebhook(raw,request.headers,secret,now()))throw failure('zoom_forbidden',401);
    const event=JSON.parse(raw);
    if(event.event==='endpoint.url_validation'){
     const token=event.payload?.plainToken;if(typeof token!=='string'||token.length>512)throw failure('zoom_invalid_request',400);
     return json({plainToken:token,encryptedToken:await hmac(secret,token)});
    }
    const projection=eventProjection(event);
    if(!projection.accountId||!Number.isFinite(projection.eventTs))throw failure('zoom_invalid_event',400);
    const result=await service('v1_zoom_receive_event',{p_environment:value('ZOOM_ENVIRONMENT'),p_dedupe:await sha256(JSON.stringify(projection)),p_event:projection});
    return json(result); // Durable receipt only; background endpoint processes it.
   }
   if(action==='dispatch'){
    const secret=value('ZOOM_DISPATCH_SECRET');if(!secret||!await verifyDispatch(secret,request.headers.get('x-odeir-zoom-dispatch')))throw failure('zoom_forbidden',401);
    await service('v1_zoom_process_events',{p_limit:10});
    await service('v1_zoom_purge',{p_limit:20});
    if(value('ZOOM_V1_ENABLED')!=='true')return json({state:'paused'});
    await service('v1_zoom_sweep',{p_limit:10});
    const leaseId=crypto.randomUUID();const jobs=await service('v1_zoom_claim',{p_lease_id:leaseId,p_limit:1});const outcomes=[];const zoom=client();
    for(const job of jobs){
     const identity={p_operation_id:job.id,p_lease_id:leaseId,p_fence:job.fence};
     try{
      const ctx=await service('v1_zoom_reconcile_context',identity);const token=await connectionAccessToken(service,zoom,job.connection_id);const link=ctx.link;let result={};
      if(job.kind==='create')result=await zoom.create(ctx.host.userId,link.kind,meetingBody(link,ctx),token.accessToken);
      else if(job.kind==='update'){
       await zoom.update(link.meeting_id,link.kind,{...meetingBody(link,ctx),schedule_for:ctx.host.userId},token.accessToken);
       result=await zoom.get(link.meeting_id,link.kind,token.accessToken);
      }else if(job.kind==='cancel')await zoom.cancel(link.meeting_id,link.kind,link.occurrence_id,token.accessToken);
      else if(job.kind==='import'){
       result=await zoom.get(link.desired.importMeetingId,link.kind,token.accessToken);
       if(result.host_id!==ctx.host.userId)throw new ZoomError('zoom_account_mismatch');
       if([3,6].includes(result.type)||[8,9].includes(result.type)&&!link.desired.occurrenceId)throw new ZoomError('zoom_occurrence_required');
       if(link.desired.occurrenceId){const occurrence=result.occurrences?.find(x=>String(x.occurrence_id)===link.desired.occurrenceId);if(!occurrence)throw new ZoomError('zoom_invalid_provider_response');result={...result,...occurrence};}
       if(Date.parse(result.start_time)!==Date.parse(link.desired.startsAt)||Number(result.duration)!==Math.ceil((Date.parse(link.desired.endsAt)-Date.parse(link.desired.startsAt))/60000))throw new ZoomError('zoom_schedule_mismatch');
      }else if(job.kind==='reconcile'){
       {
        const instances=await zoom.instances(link.meeting_id,token.accessToken,link.kind);
        await service('v1_zoom_instances_store',{...identity,p_instances:instances.meetings||instances.webinars||[]});
       }
       const refreshed=await service('v1_zoom_reconcile_context',identity);
       if(!refreshed.instances.length)throw new ZoomError('zoom_result_incomplete',{retryAfter:300});
       for(const instance of refreshed.instances){
        if(link.kind==='meeting'){const past=await zoom.past(instance.uuid,token.accessToken);await service('v1_zoom_instance_details',{...identity,p_uuid:instance.uuid,p_details:past});}
        const participants=await zoom.participants(instance.uuid,link.kind,token.accessToken);
        if(link.kind==='webinar')await service('v1_zoom_webinar_evidence',{...identity,p_uuid:instance.uuid,p_participants:participants.items,p_complete:participants.complete});
        await service('v1_zoom_store_report',{...identity,p_uuid:instance.uuid,p_participants:participants.items,p_complete:participants.complete});
        if(!participants.complete)throw new ZoomError('zoom_result_incomplete',{retryAfter:300});
        try{const recordings=await zoom.recordings(instance.uuid,token.accessToken);await service('v1_zoom_recordings_store',{...identity,p_uuid:instance.uuid,p_files:recordings.recording_files||[]});}
        catch(error){if(!['zoom_scope_or_license_required','zoom_provider_rejected'].includes(error.code))throw error;result.recordingsUnavailable=true;}
       }
      }else throw new ZoomError('zoom_unsupported_operation');
      // Failure after a mutating provider call is uncertain. Do not retry create.
      try{await service('v1_zoom_operation_complete',{...identity,p_generation:token.generation,p_outcome:'complete',p_result:{...result,id:result.id==null?null:String(result.id)}});}
      catch{throw new ZoomError('zoom_local_commit_unknown',{uncertain:['create','update','cancel','import'].includes(job.kind)});}
      outcomes.push({id:job.id,state:'complete'});
     }catch(error){
      const uncertain=error.uncertain===true;const retryable=['zoom_rate_limited','zoom_provider_unavailable','zoom_network_error','zoom_refresh_busy','zoom_result_incomplete'].includes(error.code);
      const outcome=uncertain?'uncertain':retryable?'retry':'blocked';
      await service('v1_zoom_operation_complete',{...identity,p_outcome:outcome,p_result:{code:publicCode(error)},p_retry_seconds:Math.ceil(retryDelay(error,job.attempts))}).catch(()=>{});
      outcomes.push({id:job.id,state:outcome});
     }
    }
    await service('v1_zoom_operational_tasks',{});return json({outcomes});
   }
   const authorization=request.headers.get('authorization')||'';
   if(!/^Bearer [^\s]+$/.test(authorization))throw failure('zoom_forbidden',401);
   const origin=request.headers.get('origin');if(origin&&origin!==value('ZOOM_PUBLIC_ORIGIN'))throw failure('zoom_forbidden',403);
   const body=JSON.parse(await rawBody(request,24576));
   const user=(name,args)=>rpc(name,args,authorization);
   if(typeof body.tenantSlug!=='string'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(body.tenantSlug))throw failure('zoom_invalid_request',400);
   const slug=body.tenantSlug;
   if(action==='start'||action==='complete'){
    if(!/^[a-f0-9]{64}$/.test(body.state||''))throw failure('zoom_invalid_state',400);
    const zoom=client();
    if(action==='start'){
     if(!['add','reconnect'].includes(body.mode)||body.connectionId!=null&&!UUID.test(body.connectionId))throw failure('zoom_invalid_request',400);
     const ctx=await user('v1_zoom_oauth',{p_slug:slug,p_action:body.mode,p_state_hash:await sha256(body.state),p_connection_id:body.connectionId||null});
     if(ctx.environment!==value('ZOOM_ENVIRONMENT'))throw failure('zoom_configuration_missing',503);
     return json({authorizeUrl:zoom.authorizationUrl(body.state)});
    }
    const ctx=await user('v1_zoom_oauth',{p_slug:slug,p_action:'claim',p_state_hash:await sha256(body.state)});
    if(ctx.environment!==value('ZOOM_ENVIRONMENT'))throw failure('zoom_configuration_missing',503);
    if(body.cancelled===true)return json({returnPath:ctx.returnPath,outcome:'cancelled'});
    if(typeof body.code!=='string'||!body.code||body.code.length>8192)throw failure('zoom_invalid_state',400);
    const tokens=await zoom.exchangeCode(body.code);const identity=await zoom.identity(tokens.access_token);
    const saved=await service('v1_zoom_finish_oauth',{p_attempt_id:ctx.attemptId,p_identity:identity,p_tokens:tokens});
    return json({...saved,returnPath:ctx.returnPath,outcome:'connected'});
   }
   if(action==='sync_hosts'){
    if(!UUID.test(body.connectionId))throw failure('zoom_invalid_request',400);
    const ctx=await user('v1_zoom_connection_authorize',{p_slug:slug,p_connection_id:body.connectionId});
    const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);
    let discovered;try{discovered=await zoom.users(token.accessToken);}catch(error){if(error.code!=='zoom_scope_or_license_required')throw error;discovered={items:[await zoom.identity(token.accessToken)],complete:false};}
    const hosts=[];
    for(const userInfo of discovered.items.slice(0,500)){
     const identity=await zoom.user(String(userInfo.id),token.accessToken);let settings={};
     try{settings=await zoom.settings(String(userInfo.id),token.accessToken);}catch(error){if(error.code!=='zoom_scope_or_license_required')throw error;}
     hosts.push(verifiedHost(identity,settings,ctx.accountId));
    }
    await user('v1_zoom_connection_authorize',{p_slug:slug,p_connection_id:body.connectionId});
    return json(await service('v1_zoom_sync_hosts',{p_connection_id:ctx.connectionId,p_generation:token.generation,p_hosts:hosts,p_coverage:discovered.complete?'complete':'partial'}));
   }
   if(action==='resolve'){
    if(!UUID.test(body.sessionId)||typeof body.reason!=='string')throw failure('zoom_invalid_request',400);
    const lease=crypto.randomUUID();const claim=await user('v1_zoom_recovery_begin',{p_slug:slug,p_session_id:body.sessionId,p_revision:body.expectedVersion,p_lease_id:lease,p_reason:body.reason});
    const identity={p_operation_id:claim.operationId,p_lease_id:lease,p_fence:claim.fence};
    try{
     const ctx=await service('v1_zoom_operation_context',identity);const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.link.connection_id);
     if(ctx.operation.kind==='cancel')throw failure('zoom_provider_review_required');
     const meeting=await zoom.get(body.meetingId||ctx.link.meeting_id,ctx.link.kind,token.accessToken);
     const exact=meeting.host_id===ctx.host.userId&&Date.parse(meeting.start_time)===Date.parse(ctx.link.desired.startsAt)&&Number(meeting.duration)===Math.ceil((Date.parse(ctx.link.desired.endsAt)-Date.parse(ctx.link.desired.startsAt))/60000);
     if(!exact||ctx.operation.kind==='create'&&!String(meeting.agenda||'').includes(`ODEIR session ${ctx.link.session_id}; revision ${ctx.link.revision}`))throw failure('zoom_provider_review_required');
     return json(await service('v1_zoom_operation_complete',{...identity,p_generation:token.generation,p_outcome:'complete',p_result:{...meeting,id:String(meeting.id)}}));
    }catch(error){await service('v1_zoom_operation_complete',{...identity,p_outcome:'uncertain',p_result:{code:'zoom_provider_review_required'}}).catch(()=>{});throw error;}
   }
   if(action==='webinar_register'){
    if(!UUID.test(body.registrationId))throw failure('zoom_invalid_request',400);const lease=crypto.randomUUID();
    const ctx=await user('v1_zoom_webinar_registration',{p_slug:slug,p_registration_id:body.registrationId,p_lease_id:lease});if(ctx.status!=='register')return json(ctx,ctx.status==='registered'?200:409);
    const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);const registered=await zoom.register(ctx.meetingId,'webinar',{email:ctx.email,first_name:ctx.name},token.accessToken);
    await user('v1_zoom_webinar_registration',{p_slug:slug,p_registration_id:body.registrationId,p_lease_id:lease});
    return json(await service('v1_zoom_webinar_complete',{p_registration_id:body.registrationId,p_lease_id:lease,p_generation:token.generation,p_result:registered}));
   }
   if(action==='transcript'){
    if(!UUID.test(body.recordingId))throw failure('zoom_invalid_request',400);
    const ctx=await user('v1_zoom_transcript_authorize',{p_slug:slug,p_recording_id:body.recordingId});const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);
    const recordings=await zoom.recordings(ctx.uuid,token.accessToken);const file=recordings.recording_files?.find(f=>f.id===ctx.fileId&&['TRANSCRIPT','CC'].includes(f.file_type));
    if(!file||!zoomUrl(file.download_url))throw failure('zoom_transcript_unavailable');
    const response=await fetchImpl(file.download_url,{headers:{authorization:`Bearer ${token.accessToken}`},redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw failure('zoom_transcript_unavailable');
    const text=await rawBody(new Request('https://localhost',{method:'POST',body:response.body,duplex:'half'}),1048576);
    await user('v1_zoom_transcript_authorize',{p_slug:slug,p_recording_id:body.recordingId});
    return json(await service('v1_zoom_transcript_store',{p_recording_id:body.recordingId,p_generation:token.generation,p_text:text}));
   }
   if(action==='sdk'){
    if(!UUID.test(body.sessionId)||!body.asHost&&!UUID.test(body.enrollmentId))throw failure('zoom_invalid_request',400);
    if(value('ZOOM_SDK_ENABLED')!=='true')return json(sdkDecision({enabled:false}));
    const grant=await user('v1_zoom_access',{p_slug:slug,p_session_id:body.sessionId,p_enrollment_id:body.enrollmentId||null,p_action:body.asHost===true?'start':'join'});const lease=crypto.randomUUID();
    const ctx=await service('v1_zoom_sdk_context',{p_grant_id:grant.grantId,p_lease:lease});const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);
    const review=value('ZOOM_SDK_REVIEWED')==='true',appAccountId=value('ZOOM_SDK_APP_ACCOUNT_ID');
    let personal=null;try{const person=await zoom.user(ctx.email,token.accessToken);if(person.account_id===ctx.accountId&&person.email?.toLowerCase()===ctx.email&&person.status==='active'&&(ctx.role===0||person.id===ctx.providerUserId))personal=person;}catch(error){if(!['zoom_provider_rejected','zoom_scope_or_license_required'].includes(error.code))throw error;}
    const decision=sdkDecision({enabled:true,reviewed:review,appAccountId,accountId:ctx.accountId,role:ctx.role,personalIdentity:!!personal});if(!decision.available)return json(decision);
    const meeting=await zoom.get(ctx.meetingId,ctx.kind,token.accessToken);let registration=null;
    if(ctx.role===0){registration=await service('v1_zoom_access_context',{p_grant_id:grant.grantId,p_lease:lease});if(registration.status==='register'){const record=await zoom.register(ctx.meetingId,ctx.kind,{email:registration.email,first_name:registration.name,occurrence_ids:registration.occurrenceId||undefined},token.accessToken);registration=await service('v1_zoom_registration_complete',{p_grant_id:grant.grantId,p_lease:lease,p_result:record});}if(!registration.url)throw failure('zoom_registration_pending');}
    const zak=decision.requiresZak?(await zoom.userToken(personal.id,'zak',token.accessToken)).token:null;
    await service('v1_zoom_sdk_context',{p_grant_id:grant.grantId,p_lease:lease});
    const clientId=value('ZOOM_SDK_CLIENT_ID'),secret=value('ZOOM_SDK_CLIENT_SECRET');
    const signature=await sdkSignature({clientId,secret,meetingId:ctx.meetingId,role:ctx.role,now:now()});
    return json({available:true,version:ZOOM_SDK_VERSION,tenantSlug:slug,clientId,signature,meetingNumber:ctx.meetingId,password:meeting.password||'',name:ctx.name,email:ctx.email,registrantToken:registration?.url?new URL(registration.url).searchParams.get('tk'):null,zak});
   }
   if(action==='verify_host'){
    if(!UUID.test(body.hostId)||!UUID.test(body.instructorId))throw failure('zoom_invalid_request',400);
    const ctx=await user('v1_zoom_host_identity',{p_slug:slug,p_host_id:body.hostId,p_subject_id:body.instructorId});
    const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);const identity=await zoom.user(ctx.email,token.accessToken);
    await user('v1_zoom_host_identity',{p_slug:slug,p_host_id:body.hostId,p_subject_id:body.instructorId});
    return json(await service('v1_zoom_host_identity_save',{p_host_id:body.hostId,p_subject_id:body.instructorId,p_identity:identity,p_generation:token.generation}));
   }
   if(action==='join'||action==='instructor_start'){
    if(!UUID.test(body.sessionId)||action==='join'&&!UUID.test(body.enrollmentId))throw failure('zoom_invalid_request',400);
    const grant=await user('v1_zoom_access',{p_slug:slug,p_session_id:body.sessionId,p_enrollment_id:body.enrollmentId||null,p_action:action==='join'?'join':'start'});
    const lease=crypto.randomUUID();let ctx=await service('v1_zoom_access_context',{p_grant_id:grant.grantId,p_lease:lease});
    if(ctx.status==='ready'){if(!zoomUrl(ctx.url))throw failure('zoom_invalid_provider_response');return json({url:ctx.url});}
    if(ctx.status==='busy'||ctx.status==='uncertain')return json({status:ctx.status},409);
    const zoom=client();const token=await connectionAccessToken(service,zoom,ctx.connectionId);
    if(ctx.action==='start'){
     const meeting=await zoom.get(ctx.meetingId,ctx.kind,token.accessToken);
     // Alternative hosts authenticate as themselves in Zoom; never receive the
     // original account owner's start_url/ZAK.
     const url=ctx.authorizationKind==='host'&&meeting.host_id===ctx.providerUserId?meeting.start_url:meeting.join_url;
     await service('v1_zoom_access_context',{p_grant_id:grant.grantId,p_lease:lease});
     if(!zoomUrl(url))throw failure('zoom_invalid_provider_response');return json({url,requiresZoomLogin:ctx.authorizationKind!=='host'});
    }
    const registered=await zoom.register(ctx.meetingId,ctx.kind,{email:ctx.email,first_name:ctx.name,occurrence_ids:ctx.occurrenceId||undefined},token.accessToken);
    const result=await service('v1_zoom_registration_complete',{p_grant_id:grant.grantId,p_lease:lease,p_result:registered});
    if(!zoomUrl(result.url))throw failure('zoom_invalid_provider_response');return json(result);
   }
   return json({error:'zoom_not_found'},404);
  }catch(error){return json({error:publicCode(error),correlationId},error?.status>=400&&error.status<600?error.status:409);}
 };
}
