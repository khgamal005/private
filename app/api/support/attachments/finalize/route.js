import {NextResponse} from 'next/server';
import {
  SUPPORT_ATTACHMENT_LIMIT,
  SupportHttpError,
  failure,
  integer,
  jsonBody,
  sameOrigin,
  sessionToken,
  supportRpc,
  uuid
} from '../../_shared';
import {
  SUPPORT_ATTACHMENTS_ENABLED,
  SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE
} from '../../../../../lib/support-attachment-policy';

export async function POST(request){
  if(!SUPPORT_ATTACHMENTS_ENABLED){
    return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503);
  }
  try{
    if(!sameOrigin(request))return failure('forbidden',403);
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const body=await jsonBody(request);
    const result=await supportRpc(token,'v3_support_attachment_finalize',{
      p_attachment_id:uuid(body.attachmentId,{required:true}),
      p_size_bytes:integer(body.sizeBytes,{
        required:true,
        min:1,
        max:SUPPORT_ATTACHMENT_LIMIT
      })
    });
    return NextResponse.json({
      success:true,
      attachment:result?.attachment||result
    },{headers:{'cache-control':'no-store'}});
  }catch(error){
    if(error instanceof SupportHttpError)return failure(error.code,error.status);
    console.error('[support-attachment-finalize-failure]',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return failure('support_request_failed',500);
  }
}