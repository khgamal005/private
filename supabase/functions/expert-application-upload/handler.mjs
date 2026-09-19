import {parseExpertMultipart,sha256,BUCKET,fail} from '../_shared/expert-files.mjs';

const receipt=()=>Response.json({success:true},{headers:{'Cache-Control':'no-store'}});
export function createHandler({url,secret,publicKeys,fetcher=fetch,defer=promise=>{void promise;}}){
  const adminHeaders={apikey:secret,...(secret?.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${secret}`})};
  const rpc=async(name,body={})=>{
    const response=await fetcher(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers:{...adminHeaders,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok){const code=String(data?.message||'');if(code.includes('rate_limited'))throw fail('تم استقبال عدة طلبات مؤخرًا. حاول لاحقًا.',429);if(code==='service_hub_not_enabled')throw fail('رفع الملفات غير متاح مؤقتًا. حاول لاحقًا.',503);if(code==='service_upload_conflict')throw fail('تغيرت بيانات الطلب. حدّث أحد الحقول ثم أعد الإرسال.',409);if(code==='service_upload_expired')throw fail('انتهت مهلة رفع الملفات. حدّث أحد الحقول ثم أعد الإرسال.',409);throw fail('تعذر حفظ الطلب الآن. أعد المحاولة بنفس البيانات.',503);}
    return data;
  };
  const storageHeaders=adminHeaders;
  async function cleanup(){
    for(const item of await rpc('v1_expert_upload_cleanup')){
      const response=await fetcher(`${url}/storage/v1/object/${BUCKET}`,{method:'DELETE',headers:{...storageHeaders,'Content-Type':'application/json'},body:JSON.stringify({prefixes:item.paths}),signal:AbortSignal.timeout(15000)});
      if(response.ok)await rpc('v1_expert_upload_cleaned',{p_id:item.id});
    }
  }
  return async request=>{
    try{
      if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
      if(!secret||!url||!publicKeys?.filter(Boolean).includes(request.headers.get('apikey')))return Response.json({error:'غير مصرح.'},{status:401});
      const parsed=await parseExpertMultipart(request);if(parsed.honeypot)return receipt();
      // Cleanup failure must not turn a successfully saved application into an error.
      // A scheduled/manual maintenance invocation may run this same function as well.
      const manifest=parsed.files.map(({bytes,...descriptor})=>descriptor);
      const reservation=await rpc('v1_expert_upload_reserve',{p_id:parsed.requestKey,p_payload:parsed.payload,p_manifest:manifest});
      if(reservation.complete)return receipt();
      for(const file of parsed.files){
        const path=`${parsed.requestKey}/${file.kind}`;
        const response=await fetcher(`${url}/storage/v1/object/${BUCKET}/${path}`,{method:'POST',headers:{...storageHeaders,'Content-Type':file.mimeType,'x-upsert':'false'},body:file.bytes,signal:AbortSignal.timeout(30000)});
        if(!response.ok){
          let error;try{error=await response.json();}catch{throw fail('تعذر رفع الملف الآن. أعد المحاولة.',503);}
          if(![409,400].includes(response.status)||!['Duplicate','409'].includes(String(error.error||error.statusCode)))throw fail('تعذر رفع الملف الآن. أعد المحاولة.',503);
          // A retry may find the first upload committed. Verify bytes before reusing it.
          const existing=await fetcher(`${url}/storage/v1/object/authenticated/${BUCKET}/${path}`,{headers:storageHeaders,signal:AbortSignal.timeout(15000)});
          if(!existing.ok)throw fail('تعذر التحقق من الملف. أعد المحاولة.',503);
          const bytes=new Uint8Array(await existing.arrayBuffer());
          if(bytes.length!==file.size||await sha256(bytes)!==file.sha256)throw fail('تعارض في الملف المرفوع. حدّث الملف ثم أعد الإرسال.',409);
        }
      }
      await rpc('v1_expert_upload_finalize',{p_id:parsed.requestKey});
      // Only expired, unclaimed paths can be deleted. Never delete on ambiguous finalize errors.
      defer(cleanup().catch(()=>{}));
      return receipt();
    }catch(error){return Response.json({error:error.status?error.message:'تعذر الاتصال الآن. أعد المحاولة بنفس البيانات.'},{status:error.status||503,headers:{'Cache-Control':'no-store'}});}
  };
}
