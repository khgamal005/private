import 'server-only';

import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {
  SupportHttpError,
  sameOrigin,
  sessionToken,
  supportRpc
} from '../../support/_shared';
import {OdeiryContractError} from '../../../../lib/odeiry-contract.mjs';
import {
  parseOdeiryManagerCapability,
  parseOdeiryManagerMemoryActionResult,
  parseOdeiryManagerRequest,
  parseOdeiryManagerThreadResult,
  parseOdeiryManagerWorkspaceResult
} from '../../../../lib/odeiry-manager-contract.mjs';
import {
  OdeiryRateLimiter,
  readOdeiryJson
} from '../../../../lib/odeiry-request-guard.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const rateLimiter=new OdeiryRateLimiter({limit:30,windowMs:60*1000});

export async function POST(request){
  try{
    // The base server-only switch closes the surface completely. The Manager
    // switch closes analysis, but reviewed memory remains reject/archiveable
    // for an authorized owner through the lifecycle path below.
    if(process.env.ODEIRY_AI_ENABLED!=='true'){
      return managerFailure('odeiry_manager_unavailable',503);
    }
    const managerRuntimeEnabled=process.env.ODEIRY_MANAGER_ENABLED==='true';
    if(!sameOrigin(request))return managerFailure('forbidden',403);
    const token=await sessionToken();
    if(!token)return managerFailure('authentication_required',401);

    const input=parseOdeiryManagerRequest(await readOdeiryJson(request));
    const rate=rateLimiter.consume(rateKey(token,input.slug,input.action));
    if(!rate.allowed){
      return managerFailure('odeiry_manager_rate_limit_exceeded',429,{
        retryAfter:rate.retryAfterSeconds
      });
    }

    const capability=parseOdeiryManagerCapability(await supportRpc(
      token,
      'v3_tenant_odeiry_snapshot',
      {p_slug:input.slug}
    ));
    // A platform operator is deliberately excluded even if the operations
    // assistant is available to that account. Manager memory is personal to
    // a real tenant membership and must never be opened through platform mode.
    if(capability.mode==='platform_operator'||!capability.allowed){
      return managerFailure('forbidden',403);
    }
    const lifecycleAction=capability.reviewAvailable&&(
      input.action==='workspace'
      ||(input.action==='review_memory'
        &&['reject','archive'].includes(input.decision))
    );
    const fullAccess=managerRuntimeEnabled&&capability.available;
    if(!fullAccess&&!lifecycleAction){
      return managerFailure('odeiry_manager_unavailable',503);
    }

    const data=await managerAction(token,input,{lifecycleOnly:!fullAccess});
    return NextResponse.json({success:true,data},{headers:responseHeaders()});
  }catch(error){
    if(error instanceof OdeiryContractError){
      const code=allowedContractCode(error.code);
      return managerFailure(code,statusFor(code,error.status));
    }
    if(error instanceof SupportHttpError){
      const code=allowedDatabaseCode(error.code);
      return managerFailure(code,statusFor(code,error.status));
    }
    console.error('[odeiry-manager-route-failure]',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return managerFailure('odeiry_manager_request_failed',502);
  }
}

async function managerAction(token,input,{lifecycleOnly=false}={}){
  if(input.action==='workspace'){
    const result=await supportRpc(
      token,
      'v1_tenant_odeiry_manager_workspace',
      {p_slug:input.slug}
    );
    const workspace=parseOdeiryManagerWorkspaceResult(result);
    // The application kill switch may close before the database gates do.
    // Keep memory deletion reachable without returning conversation metadata.
    return lifecycleOnly?{...workspace,threads:[]}:workspace;
  }
  if(input.action==='thread'){
    const result=await supportRpc(
      token,
      'v1_tenant_odeiry_manager_thread',
      {p_slug:input.slug,p_thread_id:input.threadId}
    );
    return parseOdeiryManagerThreadResult(result);
  }
  const result=await supportRpc(
    token,
    'v1_tenant_odeiry_manager_memory_action',
    {
      p_slug:input.slug,
      p_action:input.decision,
      p_memory_id:input.memoryId,
      p_expected_version:input.expectedVersion,
      p_client_request_id:input.clientRequestId
    }
  );
  return parseOdeiryManagerMemoryActionResult(result,{
    action:input.decision,
    memoryId:input.memoryId
  });
}

function rateKey(token,slug,action){
  return createHash('sha256')
    .update(token)
    .update('\0manager\0')
    .update(slug)
    .update('\0')
    .update(action)
    .digest('hex');
}

function allowedContractCode(code){
  return new Set([
    'odeiry_payload_invalid','odeiry_json_invalid',
    'odeiry_unsupported_media_type','odeiry_request_too_large',
    'odeiry_manager_payload_invalid','odeiry_manager_action_invalid',
    'odeiry_manager_slug_invalid','odeiry_manager_thread_id_invalid',
    'odeiry_manager_memory_id_invalid',
    'odeiry_manager_memory_action_invalid',
    'odeiry_manager_expected_version_invalid',
    'odeiry_manager_client_request_id_invalid',
    'odeiry_manager_response_invalid'
  ]).has(code)?code:'odeiry_manager_payload_invalid';
}

function allowedDatabaseCode(code){
  return new Set([
    'authentication_required','forbidden','tenant_not_found',
    'odeiry_disabled','odeiry_manager_unavailable',
    'odeiry_manager_permission_required',
    'odeiry_manager_thread_not_found','odeiry_manager_memory_not_found',
    'odeiry_manager_memory_action_invalid',
    'odeiry_manager_version_conflict',
    'odeiry_manager_idempotency_conflict',
    'odeiry_manager_memory_limit_reached',
    'odeiry_manager_memory_key_conflict',
    'odeiry_manager_payload_invalid',
    'odeiry_manager_cross_mode_forbidden',
    'odeiry_manager_execution_forbidden',
    'support_upstream_timeout','support_upstream_unavailable'
  ]).has(code)?code:'odeiry_manager_request_failed';
}

function statusFor(code,fallback=400){
  if(code==='authentication_required')return 401;
  if(new Set([
    'forbidden','odeiry_manager_permission_required',
    'odeiry_manager_execution_forbidden'
  ]).has(code))return 403;
  if(code==='tenant_not_found'||code.endsWith('_not_found'))return 404;
  if(new Set([
    'odeiry_manager_version_conflict',
    'odeiry_manager_idempotency_conflict',
    'odeiry_manager_memory_limit_reached',
    'odeiry_manager_memory_key_conflict',
    'odeiry_manager_cross_mode_forbidden'
  ]).has(code))return 409;
  if(code==='odeiry_manager_rate_limit_exceeded')return 429;
  if(code==='odeiry_manager_unavailable'||code==='odeiry_disabled')return 503;
  if(code==='support_upstream_timeout')return 504;
  if(code==='support_upstream_unavailable'
     ||code==='odeiry_manager_response_invalid'
     ||code==='odeiry_manager_request_failed')return 502;
  return fallback>=500?502:400;
}

function managerFailure(code,status,{retryAfter=0}={}){
  const headers=responseHeaders();
  if(retryAfter)headers['retry-after']=String(retryAfter);
  return NextResponse.json({
    success:false,
    code,
    error:messageFor(code)
  },{status,headers});
}

function messageFor(code){
  return ({
    authentication_required:'انتهت الجلسة؛ سجّل الدخول ثم حاول مرة أخرى.',
    forbidden:'أوديري المدير متاح فقط لمدير مؤهل داخل المنشأة.',
    tenant_not_found:'تعذر العثور على المنشأة.',
    odeiry_payload_invalid:'بيانات الطلب غير صالحة.',
    odeiry_json_invalid:'تعذر قراءة بيانات الطلب.',
    odeiry_unsupported_media_type:'يجب إرسال الطلب بصيغة JSON.',
    odeiry_request_too_large:'حجم الطلب أكبر من الحد المسموح.',
    odeiry_manager_payload_invalid:'بيانات طلب أوديري المدير غير صالحة.',
    odeiry_manager_action_invalid:'عملية أوديري المدير غير مدعومة.',
    odeiry_manager_slug_invalid:'مسار المنشأة غير صالح.',
    odeiry_manager_thread_id_invalid:'معرّف المحادثة غير صالح.',
    odeiry_manager_memory_id_invalid:'معرّف الذاكرة غير صالح.',
    odeiry_manager_memory_action_invalid:'قرار مراجعة الذاكرة غير صالح.',
    odeiry_manager_expected_version_invalid:'نسخة الذاكرة غير صالحة؛ حدّث القائمة.',
    odeiry_manager_client_request_id_invalid:'معرّف محاولة المراجعة غير صالح.',
    odeiry_manager_permission_required:'ليست لديك صلاحية استخدام أوديري المدير.',
    odeiry_manager_thread_not_found:'المحادثة غير موجودة أو ليست ضمن صلاحياتك.',
    odeiry_manager_memory_not_found:'الذاكرة غير موجودة أو ليست ضمن صلاحياتك.',
    odeiry_manager_version_conflict:'تغيّرت الذاكرة؛ حدّث القائمة ثم راجعها من جديد.',
    odeiry_manager_idempotency_conflict:'استُخدم معرّف المحاولة لقرار مختلف.',
    odeiry_manager_memory_limit_reached:'وصلت الذاكرة المعتمدة إلى الحد المسموح؛ أرشف معلومة قديمة أولًا.',
    odeiry_manager_memory_key_conflict:'توجد معلومة معتمدة للموضوع نفسه؛ راجع الذاكرة الحالية أولًا.',
    odeiry_manager_cross_mode_forbidden:'لا يمكن فتح هذه المحادثة في وضع المدير.',
    odeiry_manager_execution_forbidden:'أوديري المدير للقراءة والتحليل فقط.',
    odeiry_manager_rate_limit_exceeded:'انتظر قليلًا قبل إعادة المحاولة.',
    odeiry_manager_unavailable:'أوديري المدير غير متاح حاليًا.',
    odeiry_disabled:'أوديري غير مفعّل حاليًا.',
    support_upstream_timeout:'تأخر اتصال الخدمة؛ حاول مرة أخرى بعد لحظات.',
    support_upstream_unavailable:'الخدمة غير متاحة مؤقتًا؛ حاول مرة أخرى.',
    odeiry_manager_response_invalid:'تعذر التحقق من استجابة أوديري المدير.'
  })[code]||'تعذر تنفيذ طلب أوديري المدير الآن.';
}

function responseHeaders(){
  return {
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    vary:'Cookie'
  };
}
