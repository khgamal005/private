import {estimateOdeiryUnits,resolveOdeiryModel,settleOdeiryUnits} from './odeiry-contract.mjs';

export function transcriptSegments(text){
 if(typeof text!=='string'||text.length>180000)throw Error('zoom_transcript_too_large');
 const clean=text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu,'[بريد محجوب]').replace(/\+?\d[\d ()-]{7,}\d/g,'[رقم محجوب]');
 const blocks=clean.split(/\r?\n\s*\r?\n/).map(b=>b.trim()).filter(Boolean);const segments=[];
 for(const block of blocks){const rows=block.split(/\r?\n/),index=rows.findIndex(x=>x.includes('-->'));if(index<0)continue;const times=rows[index].match(/(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s+-->\s+(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);if(!times)continue;const content=rows.slice(index+1).join(' ').replace(/<[^>]+>/g,'').replace(/^.{1,80}:\s*/, '').trim();if(content)segments.push({id:`s${segments.length+1}`,start:times[1],end:times[2],text:content});}
 if(!segments.length)throw Error('zoom_transcript_format_unsupported');return segments;
}
export function validateZoomDraft(output,segments){
 if(!output||typeof output.title!=='string'||typeof output.summary!=='string'||!Array.isArray(output.points)||!Array.isArray(output.questions)||!Array.isArray(output.sources)||output.summary.length>6000||output.questions.length>10)throw Error('zoom_invalid_ai_response');
 if(output.questions.some(q=>!q||typeof q.prompt!=='string'||!Array.isArray(q.options)||q.options.length<2||q.options.length>6||q.options.some(x=>typeof x!=='string')||!Number.isInteger(q.correctOptionIndex)||q.correctOptionIndex<0||q.correctOptionIndex>=q.options.length))throw Error('zoom_invalid_ai_response');
 const sourceIds=new Set(segments.map(s=>s.id));if(!output.sources.length||output.sources.some(id=>!sourceIds.has(id)))throw Error('zoom_invalid_ai_sources');
 return {...output,state:'draft',sources:output.sources.map(id=>{const s=segments.find(x=>x.id===id);return {id,start:s.start,end:s.end};})};
}
export async function generateZoomDraft({slug,commandId,payload,rpc,finalize,generate,configured=true,model=resolveOdeiryModel()}){
 if(!configured)throw Error('zoom_ai_configuration_missing');
 const prepared=await rpc('v1_zoom_ai_prepare',{p_slug:slug,p_command_id:commandId,p_payload:payload});
 const started=await rpc('v3_tenant_odeiry_action',{p_slug:slug,p_action:'start_run',p_payload:{clientRequestId:`zoom:${prepared.draftId}`,userMessage:`إنشاء مسودة ${payload.kind} من تفريغ مصرح به؛ المصدر ${prepared.sourceHash}؛ الإصدار ${prepared.sourceRevision}.`,estimatedUnits:Math.max(80,estimateOdeiryUnits(prepared.sourceHash)),model,context:{module:'courses',pathClass:'workspace.courses'}}});
 if(started.idempotent){if(started.status==='completed')return rpc('v1_zoom_ai_finish',{p_slug:slug,p_draft_id:prepared.draftId});throw Error('zoom_generation_in_progress');}
 let providerCompleted=false;
 try{
  const source=await rpc('v1_zoom_ai_context',{p_slug:slug,p_draft_id:prepared.draftId,p_run_id:started.runId});
  const segments=transcriptSegments(source.transcript);const result=await generate({kind:source.kind,segments,model});providerCompleted=true;
  const draft=validateZoomDraft(result.output,segments);const units=settleOdeiryUnits(result.usage,started.reservedUnits);
  await finalize({slug,runId:started.runId,status:'completed',payload:{responseText:draft.summary,responseData:draft,actualUnits:units.settled,measuredActualUnits:units.measured,inputTokens:result.usage?.inputTokens||0,outputTokens:result.usage?.outputTokens||0,cachedInputTokens:0,reasoningTokens:0,model,providerResponseId:result.providerResponseId||null,finishReason:'completed',citationKeys:[],metadata:{sourceCount:draft.sources.length,knowledgeSearchEnabled:false}}});
  return await rpc('v1_zoom_ai_finish',{p_slug:slug,p_draft_id:prepared.draftId});
 }catch(error){
  // A lost finalization after real provider consumption must not trigger another
  // paid generation under the same request. Existing Odeiry receipt is durable.
  if(!providerCompleted)await finalize({slug,runId:started.runId,status:'failed',payload:{errorCode:'zoom_generation_failed',metadata:{}}}).catch(()=>{});
  throw error;
 }
}
