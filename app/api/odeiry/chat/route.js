import 'server-only';

import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {
  SupportHttpError,
  sameOrigin,
  sessionToken,
  supportRpc
} from '../../support/_shared';
import {
  OdeiryContractError,
  cachedInputTokens,
  estimateOdeiryUnits,
  parseOdeiryRequest,
  parseOdeirySnapshot,
  parseOdeiryStartResult,
  reasoningTokens,
  replayOdeiryOutput,
  resolveOdeiryModel,
  settleOdeiryUnits
} from '../../../../lib/odeiry-contract.mjs';
import {
  OdeiryRateLimiter,
  readOdeiryJson
} from '../../../../lib/odeiry-request-guard.mjs';
import {
  OdeiryServiceRpcError,
  finalizeOdeiryRun,
  hasOdeiryServiceCredential
} from '../../../../lib/odeiry-service-rpc';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const rateLimiter=new OdeiryRateLimiter();
const MODEL_TIMEOUT_MS=30*1000;

export async function POST(request){
  let token=null;
  let input=null;
  let started=null;
  let modelCompleted=false;

  try{
    // Deliberately first: no auth, database, SDK import, or provider work can
    // occur while the independent kill switch is off.
    if(process.env.ODEIRY_AI_ENABLED!=='true'){
      return odeiryFailure('odeiry_disabled',503);
    }

    if(!sameOrigin(request))return odeiryFailure('forbidden',403);
    token=await sessionToken();
    if(!token)return odeiryFailure('authentication_required',401);

    input=parseOdeiryRequest(await readOdeiryJson(request));

    const rate=rateLimiter.consume(rateKey(token,input.slug));
    if(!rate.allowed){
      return odeiryFailure('odeiry_rate_limit_exceeded',429,{
        retryAfter:rate.retryAfterSeconds
      });
    }

    const snapshot=parseOdeirySnapshot(await supportRpc(
      token,
      'v3_tenant_odeiry_snapshot',
      {p_slug:input.slug}
    ));
    if(!snapshot.available||!snapshot.enabled){
      return odeiryFailure('odeiry_disabled',503);
    }
    // Credential state is inspected only after membership and both database
    // feature gates have succeeded, so configuration cannot be probed by an
    // unauthenticated caller or an ineligible tenant.
    const providerConfigured=String(
      process.env.OPENAI_API_KEY||''
    ).trim().length>=20;
    const serviceRpcConfigured=hasOdeiryServiceCredential();
    if(!providerConfigured||!serviceRpcConfigured){
      console.error('[odeiry-configuration-incomplete]',{
        providerConfigured,
        finalizerConfigured:serviceRpcConfigured
      });
      return odeiryFailure('odeiry_unavailable',503);
    }

    const model=resolveOdeiryModel(process.env.ODEIRY_AI_MODEL);
    started=parseOdeiryStartResult(await supportRpc(
      token,
      'v3_tenant_odeiry_action',
      {
        p_slug:input.slug,
        p_action:'start_run',
        p_payload:{
          threadId:input.threadId,
          clientRequestId:input.clientRequestId,
          userMessage:input.message,
          estimatedUnits:estimateOdeiryUnits(input.message),
          model,
          context:input.context
        }
      }
    ));

    if(started.idempotent){
      if(started.status==='completed'){
        const output=await replayOutput(started);
        return odeirySuccess(input,started,output,true);
      }
      if(['reserved','running'].includes(started.status)){
        return odeiryFailure('odeiry_request_in_progress',409,{retryAfter:3});
      }
      return odeiryFailure('odeiry_request_not_retryable',409,{
        retryWithNewRequestId:true
      });
    }

    const {runOdeiryAgent}=await import('../../../../lib/odeiry-agent.js');
    const result=await runOdeiryAgent({
      message:input.message,
      context:input.context,
      contextMessages:started.contextMessages,
      searchKnowledge:query=>supportRpc(
        token,
        'v3_tenant_odeiry_knowledge_search',
        {
          p_slug:input.slug,
          p_run_id:started.runId,
          p_query:query,
          p_limit:6
        }
      ),
      signal:modelSignal(request.signal)
    });
    modelCompleted=true;

    const units=settleOdeiryUnits(result.usage,started.reservedUnits);
    const inputTokens=nonNegativeInteger(result.usage?.inputTokens);
    const outputTokens=nonNegativeInteger(result.usage?.outputTokens);
    await finalizeWithRetry(input.slug,started.runId,'completed',{
      responseText:result.output.reply,
      responseData:result.output,
      actualUnits:units.settled,
      measuredActualUnits:units.measured,
      inputTokens,
      outputTokens,
      cachedInputTokens:cachedInputTokens(result.usage),
      reasoningTokens:reasoningTokens(result.usage),
      model:result.model,
      providerResponseId:result.providerResponseId,
      finishReason:'completed',
      citationKeys:result.output.sources.map(source=>source.articleId),
      metadata:{
        sourceCount:result.output.sources.length,
        knowledgeSearchEnabled:true
      }
    });

    return odeirySuccess(input,started,result.output,false);
  }catch(error){
    let retryWithNewRequestId=false;
    if(started&&!started.idempotent&&input){
      retryWithNewRequestId=await finalizeFailureSafely(
        input.slug,started.runId,error,request.signal,modelCompleted
      );
    }
    return routeError(error,started?.runId||null,{retryWithNewRequestId});
  }
}

async function replayOutput(started){
  if(started.responseData){
    try{
      const {parseOdeiryAgentOutput}=await import('../../../../lib/odeiry-agent.js');
      return parseOdeiryAgentOutput(started.responseData);
    }catch{
      // A stored response from an older contract still has a safe text fallback.
    }
  }
  return replayOdeiryOutput(started.responseText);
}

async function finalizeWithRetry(slug,runId,status,payload){
  const request={slug,runId,status,payload};
  try{
    return await finalizeOdeiryRun(request);
  }catch(error){
    if(!(error instanceof OdeiryServiceRpcError)
       ||!['odeiry_persistence_timeout','odeiry_persistence_unavailable'].includes(error.code)){
      throw error;
    }
    return finalizeOdeiryRun(request);
  }
}

async function finalizeFailureSafely(
  slug,runId,error,requestSignal,providerCalled
){
  const status=requestSignal?.aborted?'cancelled':'failed';
  try{
    await finalizeWithRetry(slug,runId,status,{
      errorCode:providerCalled===true
        ?'odeiry_persistence_failed':safeAgentErrorCode(error),
      metadata:{providerCalled:providerCalled===true}
    });
    return true;
  }catch(finalizeError){
    console.error('[odeiry-finalize-failure]',{
      runId,
      errorName:finalizeError instanceof Error?finalizeError.name:'UnknownError'
    });
    return false;
  }
}

function odeirySuccess(input,started,output,idempotent){
  return NextResponse.json({
    success:true,
    data:{
      threadId:started.threadId,
      runId:started.runId,
      reply:output.reply,
      steps:output.steps,
      suggestions:output.suggestions,
      confidence:output.confidence,
      needsEscalation:output.needsEscalation,
      escalationReason:output.escalationReason,
      sources:output.sources,
      ticketDraft:output.ticketDraft,
      idempotent
    },
    requestId:input.clientRequestId
  },{
    headers:responseHeaders()
  });
}

function odeiryFailure(
  code,status,{retryAfter,retryWithNewRequestId=false}={}
){
  const headers=responseHeaders();
  if(retryAfter)headers['retry-after']=String(retryAfter);
  return NextResponse.json({
    success:false,
    code,
    error:translateOdeiryError(code),
    unavailable:status>=500,
    retryWithNewRequestId
  },{status,headers});
}

function routeError(error,runId,{retryWithNewRequestId=false}={}){
  if(error instanceof OdeiryContractError){
    return odeiryFailure(error.code,error.status,{retryWithNewRequestId});
  }
  if(error instanceof SupportHttpError){
    const code=normalizeDatabaseError(error.code);
    return odeiryFailure(code,statusFor(code,error.status),{
      retryWithNewRequestId
    });
  }
  if(error instanceof OdeiryServiceRpcError){
    return odeiryFailure(error.code,error.status,{retryWithNewRequestId});
  }
  const code=safeAgentErrorCode(error);
  console.error('[odeiry-route-failure]',{
    runId,
    code,
    errorName:error instanceof Error?error.name:'UnknownError'
  });
  return odeiryFailure(code,statusFor(code,500),{retryWithNewRequestId});
}

function modelSignal(requestSignal){
  const timeout=AbortSignal.timeout(MODEL_TIMEOUT_MS);
  if(!requestSignal)return timeout;
  return typeof AbortSignal.any==='function'
    ?AbortSignal.any([requestSignal,timeout])
    :timeout;
}

function rateKey(token,slug){
  return createHash('sha256')
    .update(token)
    .update('\0')
    .update(slug)
    .digest('hex');
}

function safeAgentErrorCode(error){
  const name=error instanceof Error?error.name:'';
  if(['AbortError','TimeoutError','ModelTimeoutError'].includes(name)){
    return 'odeiry_provider_timeout';
  }
  if([
    'MaxTurnsExceededError','ModelBehaviorError','ModelRefusalError','ZodError'
  ].includes(name))return 'odeiry_response_invalid';
  return 'odeiry_provider_unavailable';
}

function normalizeDatabaseError(code){
  const allowed=new Set([
    'authentication_required','forbidden','tenant_not_found','odeiry_disabled',
    'odeiry_rate_limit_exceeded','odeiry_idempotency_conflict',
    'odeiry_request_in_progress','odeiry_units_unavailable',
    'odeiry_thread_not_found','odeiry_run_not_found','odeiry_run_conflict',
    'odeiry_payload_invalid'
  ]);
  return allowed.has(code)?code:'odeiry_request_failed';
}

function statusFor(code,fallback=500){
  if(code==='authentication_required')return 401;
  if(code==='forbidden')return 403;
  if(code==='tenant_not_found'||code.endsWith('_not_found'))return 404;
  if(code==='odeiry_rate_limit_exceeded')return 429;
  if([
    'odeiry_idempotency_conflict','odeiry_request_in_progress',
    'odeiry_run_conflict','odeiry_request_not_retryable'
  ].includes(code))return 409;
  if(code==='odeiry_units_unavailable')return 402;
  if(code==='odeiry_provider_timeout')return 504;
  if(code==='odeiry_disabled'||code==='odeiry_unavailable')return 503;
  if(code==='odeiry_payload_invalid')return 400;
  return fallback>=500?502:Math.max(400,fallback);
}

function translateOdeiryError(code){
  return ({
    authentication_required:'انتهت الجلسة؛ سجّل الدخول ثم حاول مرة أخرى.',
    forbidden:'ليست لديك صلاحية لاستخدام أوديري في هذه المنشأة.',
    tenant_not_found:'تعذر العثور على المنشأة.',
    odeiry_disabled:'أوديري غير مفعّل لهذه المنشأة حاليًا.',
    odeiry_unavailable:'أوديري غير متاح مؤقتًا. حاول مرة أخرى لاحقًا.',
    odeiry_rate_limit_exceeded:'أرسلت عدة طلبات متتالية. انتظر قليلًا ثم حاول مجددًا.',
    odeiry_request_in_progress:'هذا الطلب قيد المعالجة بالفعل.',
    odeiry_idempotency_conflict:'تعذر إعادة الطلب لأن معرّفه مستخدم لمحتوى مختلف.',
    odeiry_request_not_retryable:'انتهت محاولة هذا الطلب؛ أرسل الطلب مجددًا بمعرّف جديد.',
    odeiry_units_unavailable:'لا تتوفر وحدات كافية لتنفيذ الطلب.',
    odeiry_thread_not_found:'تعذر العثور على المحادثة.',
    odeiry_run_not_found:'تعذر العثور على عملية أوديري.',
    odeiry_run_conflict:'تغيّرت حالة العملية؛ حدّث الصفحة ثم حاول مرة أخرى.',
    odeiry_slug_invalid:'مسار المنشأة غير صالح.',
    odeiry_message_invalid:'اكتب سؤالًا واضحًا ضمن الحد المسموح.',
    odeiry_client_request_id_invalid:'معرّف الطلب غير صالح.',
    odeiry_thread_id_invalid:'معرّف المحادثة غير صالح.',
    odeiry_context_invalid:'سياق شاشة أودير غير صالح.',
    odeiry_context_scope_invalid:'سياق الشاشة لا يخص هذه المنشأة.',
    odeiry_module_invalid:'قسم أودير المحدد غير صالح.',
    odeiry_payload_invalid:'بيانات الطلب غير صالحة.',
    odeiry_json_invalid:'تعذر قراءة بيانات الطلب.',
    odeiry_unsupported_media_type:'يجب إرسال الطلب بصيغة JSON.',
    odeiry_request_too_large:'حجم الطلب أكبر من الحد المسموح.',
    odeiry_provider_timeout:'استغرق أوديري وقتًا أطول من المتوقع. حاول مرة أخرى.',
    odeiry_response_invalid:'تعذر اعتماد إجابة آمنة لهذا الطلب. حاول بصياغة أوضح.',
    odeiry_provider_unavailable:'أوديري غير متاح مؤقتًا. لم يتم احتساب هذه المحاولة.',
    odeiry_persistence_timeout:'تأخر حفظ نتيجة أوديري. أعد المحاولة للتحقق من النتيجة.',
    odeiry_persistence_unavailable:'تعذر حفظ نتيجة أوديري مؤقتًا. أعد المحاولة للتحقق منها.',
    odeiry_persistence_rejected:'تعذر اعتماد نتيجة أوديري بأمان.',
    odeiry_service_configuration_invalid:'قناة أوديري الآمنة غير متاحة حاليًا.',
    odeiry_service_payload_invalid:'تعذر تجهيز نتيجة أوديري للحفظ الآمن.',
    odeiry_finalization_conflict:'تم اعتماد حالة مختلفة لهذا الطلب؛ أعد تحميل المحادثة.',
    odeiry_request_failed:'تعذر تنفيذ طلب أوديري الآن.'
  })[code]||'تعذر تنفيذ طلب أوديري الآن.';
}

function responseHeaders(){
  return {
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    vary:'Cookie'
  };
}

function nonNegativeInteger(value){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:0;
}
