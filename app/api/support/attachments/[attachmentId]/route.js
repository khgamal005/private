import {
  SupportHttpError,
  failure,
  sessionToken,
  storageUrl,
  supportUpstreamSignal,
  supportRpc,
  uuid
} from '../../_shared';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {
  SUPPORT_ATTACHMENTS_ENABLED,
  SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE
} from '../../../../../lib/support-attachment-policy';

export async function GET(_request,{params}){
  if(!SUPPORT_ATTACHMENTS_ENABLED){
    return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503);
  }
  try{
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const {attachmentId}=await params;
    const resolved=await supportRpc(token,'v3_support_attachment_resolve',{
      p_attachment_id:uuid(attachmentId,{required:true})
    });
    if(!resolved?.bucket||!resolved?.objectPath){
      throw new SupportHttpError('support_attachment_not_found',404);
    }
    const signedResponse=await fetch(
      storageUrl('sign',resolved.bucket,resolved.objectPath),
      {
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        method:'POST',
        body:JSON.stringify({expiresIn:60}),
        cache:'no-store',
        signal:supportUpstreamSignal()
      }
    );
    const signed=await signedResponse.json().catch(()=>null);
    if(!signedResponse.ok){
      throw new SupportHttpError(
        signedResponse.status===404?'support_attachment_not_found':'support_request_failed',
        signedResponse.status===404?404:502
      );
    }
    const signedPath=String(signed?.signedURL||signed?.signedUrl||'');
    if(!signedPath.startsWith('/object/sign/')){
      throw new SupportHttpError('support_request_failed',502);
    }
    const fileName=String(resolved.fileName||'odeir-support-attachment').replace(/[\r\n"/\\]/g,'_').slice(0,180);
    const location=new URL(`${SUPABASE_URL}/storage/v1${signedPath}`);
    location.searchParams.set('download',fileName);
    return new Response(null,{
      status:307,
      headers:{
        location:location.toString(),
        'cache-control':'private, no-store, max-age=0',
        'x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; sandbox"
      }
    });
  }catch(error){
    if(error instanceof SupportHttpError)return failure(error.code,error.status);
    console.error('[support-attachment-download-failure]',{errorName:error instanceof Error?error.name:'UnknownError'});
    return failure('support_request_failed',500);
  }
}