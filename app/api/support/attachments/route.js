import {NextResponse} from 'next/server';
import {
  SUPPORT_ATTACHMENT_LIMIT,
  SupportHttpError,
  failure,
  jsonBody,
  plainObject,
  sameOrigin,
  sessionToken,
  storageObjectPath,
  supportUpstreamSignal,
  supportRpc,
  text,
  uuid
} from '../_shared';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {
  SUPPORT_ATTACHMENTS_ENABLED,
  SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE
} from '../../../../lib/support-attachment-policy';

const MIME_EXTENSIONS=new Map([
  ['image/jpeg',new Set(['jpg','jpeg'])],
  ['image/png',new Set(['png'])],
  ['image/webp',new Set(['webp'])],
  ['image/gif',new Set(['gif'])],
  ['application/pdf',new Set(['pdf'])],
  ['text/plain',new Set(['txt'])]
]);

export async function POST(request){
  if(!SUPPORT_ATTACHMENTS_ENABLED){
    return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503);
  }
  try{
    if(!sameOrigin(request))return failure('forbidden',403);
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const body=plainObject(await jsonBody(request));
    const fileName=text(body.fileName,{required:true,max:180});
    const mimeType=text(body.mimeType,{required:true,max:100}).toLowerCase();
    const sizeBytes=Number(body.sizeBytes);
    validateFile({name:fileName,type:mimeType,size:sizeBytes});
    const ticket=await supportRpc(token,'v3_support_attachment_upload_ticket',{
      p_ticket_id:uuid(body.ticketId,{required:true}),
      p_message_id:uuid(body.messageId,{required:true}),
      p_file_name:fileName,
      p_mime_type:mimeType,
      p_size_bytes:sizeBytes,
      p_client_request_id:uuid(body.clientRequestId,{required:true})
    });
    const attachmentId=ticket?.attachmentId||ticket?.id;
    const state=String(ticket?.state||'').toLowerCase();
    if(!attachmentId||!ticket?.bucket||!ticket?.objectPath
       ||!['pending','uploaded','ready'].includes(state)){
      throw new SupportHttpError('invalid_attachment');
    }
    if(state==='ready'){
      return NextResponse.json({
        success:true,
        attachmentId,
        state,
        sizeBytes:Number(ticket.sizeBytes)||sizeBytes,
        uploadRequired:false,
        finalizeRequired:false
      },{headers:{'cache-control':'no-store'}});
    }
    if(state==='uploaded'){
      return NextResponse.json({
        success:true,
        attachmentId,
        state,
        uploadRequired:false,
        finalizeRequired:true
      },{headers:{'cache-control':'no-store'}});
    }
    const signedResponse=await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${encodeURIComponent(ticket.bucket)}/${storageObjectPath(ticket.objectPath)}`,
      {
        method:'POST',
        headers:storageHeaders(token),
        body:'{}',
        cache:'no-store',
        signal:supportUpstreamSignal()
      }
    );
    const signed=await signedResponse.json().catch(()=>null);
    if(!signedResponse.ok||!String(signed?.url||'').startsWith('/object/upload/sign/')){
      console.error('[support-attachment-sign-failure]',{
        status:signedResponse.status,
        attachmentId
      });
      throw new SupportHttpError('support_request_failed',502);
    }
    return NextResponse.json({
      success:true,
      attachmentId,
      state,
      uploadUrl:`${SUPABASE_URL}/storage/v1${signed.url}`,
      uploadRequired:true,
      finalizeRequired:true,
      expiresIn:Number(ticket.expiresIn)||900,
      maxBytes:Number(ticket.maxBytes)||SUPPORT_ATTACHMENT_LIMIT
    },{status:201,headers:{'cache-control':'no-store'}});
  }catch(error){
    if(error instanceof SupportHttpError)return failure(error.code,error.status);
    console.error('[support-attachment-route-failure]',{errorName:error instanceof Error?error.name:'UnknownError'});
    return failure('support_request_failed',500);
  }
}

function validateFile(file){
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>SUPPORT_ATTACHMENT_LIMIT){
    throw new SupportHttpError('attachment_too_large',413);
  }
  if(!file.name||file.name.length>180||/[\u0000-\u001f/\\]/.test(file.name)){
    throw new SupportHttpError('attachment_name_invalid');
  }
  const extension=file.name.toLowerCase().split('.').pop();
  const allowed=MIME_EXTENSIONS.get(file.type);
  if(!allowed||!allowed.has(extension)){
    throw new SupportHttpError('unsupported_file_type',415);
  }
}

function storageHeaders(token){
  return {
    apikey:SUPABASE_KEY,
    Authorization:`Bearer ${token}`,
    'Content-Type':'application/json'
  };
}