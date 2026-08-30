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
  parseOdeiryTicketLinkRequest
} from '../../../../lib/odeiry-contract.mjs';
import {
  OdeiryRateLimiter,
  readOdeiryJson
} from '../../../../lib/odeiry-request-guard.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const rateLimiter=new OdeiryRateLimiter();

export async function POST(request){
  try{
    if(process.env.ODEIRY_AI_ENABLED!=='true'){
      return failure('odeiry_disabled',503);
    }
    if(!sameOrigin(request))return failure('forbidden',403);
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const input=parseOdeiryTicketLinkRequest(await readOdeiryJson(request));
    const rate=rateLimiter.consume(rateKey(token,input.slug));
    if(!rate.allowed){
      return failure('odeiry_rate_limit_exceeded',429,rate.retryAfterSeconds);
    }
    const data=await supportRpc(token,'v3_tenant_odeiry_action',{
      p_slug:input.slug,
      p_action:'link_ticket',
      p_payload:{
        runId:input.runId,
        ticketId:input.ticketId,
        clientRequestId:input.clientRequestId,
        reasonCode:'user_requested'
      }
    });
    return NextResponse.json({
      success:true,
      data,
      requestId:input.clientRequestId
    },{headers:responseHeaders()});
  }catch(error){
    if(error instanceof OdeiryContractError){
      return failure(error.code,error.status);
    }
    if(error instanceof SupportHttpError){
      const code=allowedDatabaseCode(error.code);
      return failure(code,statusFor(code,error.status));
    }
    console.error('[odeiry-ticket-link-failure]',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return failure('odeiry_ticket_link_failed',502);
  }
}

function rateKey(token,slug){
  return createHash('sha256')
    .update(token)
    .update('\0ticket-link\0')
    .update(slug)
    .digest('hex');
}

function allowedDatabaseCode(code){
  return new Set([
    'authentication_required','forbidden','tenant_not_found',
    'support_ticket_not_found','odeiry_run_not_found',
    'odeiry_ticket_link_invalid','odeiry_ticket_link_conflict',
    'odeiry_rate_limit_exceeded'
  ]).has(code)?code:'odeiry_ticket_link_failed';
}

function statusFor(code,fallback){
  if(code==='authentication_required')return 401;
  if(code==='forbidden')return 403;
  if(code.endsWith('_not_found'))return 404;
  if(code==='odeiry_ticket_link_conflict')return 409;
  if(code==='odeiry_rate_limit_exceeded')return 429;
  return fallback>=500?502:400;
}

function failure(code,status,retryAfter=0){
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
    forbidden:'ليست لديك صلاحية لربط هذه التذكرة.',
    tenant_not_found:'تعذر العثور على المنشأة.',
    support_ticket_not_found:'تعذر العثور على التذكرة ضمن صلاحياتك.',
    odeiry_run_not_found:'تعذر العثور على محادثة أوديري.',
    odeiry_run_id_invalid:'معرّف محادثة أوديري غير صالح.',
    odeiry_ticket_id_invalid:'معرّف التذكرة غير صالح.',
    odeiry_client_request_id_invalid:'معرّف محاولة الربط غير صالح.',
    odeiry_slug_invalid:'مسار المنشأة غير صالح.',
    odeiry_payload_invalid:'بيانات ربط التذكرة غير صالحة.',
    odeiry_json_invalid:'تعذر قراءة بيانات ربط التذكرة.',
    odeiry_unsupported_media_type:'يجب إرسال الطلب بصيغة JSON.',
    odeiry_request_too_large:'حجم طلب الربط أكبر من الحد المسموح.',
    odeiry_ticket_link_invalid:'بيانات ربط التذكرة غير صالحة.',
    odeiry_ticket_link_conflict:'هذه المحاولة مرتبطة بتذكرة مختلفة.',
    odeiry_rate_limit_exceeded:'انتظر قليلًا قبل إعادة المحاولة.',
    odeiry_disabled:'أوديري غير مفعّل حاليًا.'
  })[code]||'أُنشئت التذكرة، لكن تعذر ربطها بمحادثة أوديري.';
}

function responseHeaders(){
  return {
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    vary:'Cookie'
  };
}
