import {readServiceBody,serviceRpc,serviceJson,serviceFailure} from '../../../../lib/service-hub-http';
import {validateExpertApplication} from '../../../../lib/service-hub.mjs';
import sharp from 'sharp';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {isTrustedSupportRequestOrigin} from '../../../../lib/support-request-origin.mjs';
import {parseExpertMultipart,fail} from '../../../../supabase/functions/_shared/expert-files.mjs';
export const runtime='nodejs';
export async function POST(request){try{
  if(request.headers.get('content-type')?.startsWith('multipart/form-data;')){
    if(!isTrustedSupportRequestOrigin(request))throw fail('تعذر التحقق من مصدر الطلب.',403);
    const parsed=await parseExpertMultipart(request);if(parsed.honeypot)return serviceJson({success:true});
    const form=new FormData();form.set('payload',JSON.stringify(parsed.payload));form.set('requestKey',parsed.requestKey);
    for(const file of parsed.files){
      if(file.kind==='photo'){
        let image;try{image=await sharp(file.bytes,{limitInputPixels:16000000,animated:false}).rotate().resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();}catch{throw fail('الصورة غير صالحة أو أبعادها كبيرة جدًا. اختر صورة أصغر.',415);}
        form.set('photo',new Blob([image],{type:'image/webp'}),file.name.replace(/\.[^.]+$/,'')+'.webp');
      }else form.set(file.kind,new Blob([file.bytes],{type:file.mimeType}),file.name);
    }
    const response=await fetch(`${SUPABASE_URL}/functions/v1/expert-application-upload`,{method:'POST',headers:{apikey:SUPABASE_KEY},body:form,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(90000)});
    const result=await response.json();
    if(!response.ok)return serviceJson({error:typeof result.error==='string'?result.error:'تعذر رفع الملفات الآن. أعد المحاولة.'},[400,401,409,413,415,429,503].includes(response.status)?response.status:503);
    return serviceJson({success:true});
  }
  const body=await readServiceBody(request);
  if(body.website)return serviceJson({success:true});
  let payload;try{payload=validateExpertApplication(body);}catch(error){return serviceJson({error:error.message},400);}
  await serviceRpc('v1_public_expert_application',{p_payload:payload},{publicAccess:true});
  return serviceJson({success:true});
}catch(error){return serviceFailure(error);}}
