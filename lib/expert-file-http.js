import sharp from 'sharp';
import {cookies} from 'next/headers';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from './config';
import {serviceRpc,serviceJson,serviceFailure} from './service-hub-http';
import {boundedBytes,BUCKET,CV_MAX,PHOTO_MAX,PHOTO_TYPES,validSignature,fail} from '../supabase/functions/_shared/expert-files.mjs';

export const validExpertId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function expertFile({id,kind,publicPhoto=false}){
  try{
    if(!validExpertId(id)||!['cv','photo'].includes(kind))return serviceJson({error:'الملف غير موجود.'},404);
    const descriptor=await serviceRpc(publicPhoto?'v1_public_expert_photo':'v1_platform_expert_file',publicPhoto?{p_provider_id:id}:{p_application_id:id,p_kind:kind},{publicAccess:publicPhoto});
    if(!descriptor)return serviceJson({error:'الملف غير موجود.'},404);
    if(!/^[0-9a-f-]{36}\/(cv|photo)$/.test(descriptor.path)||!descriptor.path.endsWith(`/${kind}`))throw Error('Invalid file descriptor');
    const token=publicPhoto?null:(await cookies()).get(ACCESS_COOKIE)?.value;
    const response=await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${descriptor.path}`,{headers:{apikey:SUPABASE_KEY,...(token?{Authorization:`Bearer ${token}`}:{})},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw fail('تعذر فتح الملف.',response.status===403||response.status===404?404:503);
    const bytes=await boundedBytes(response,kind==='cv'?CV_MAX:PHOTO_MAX);
    if(bytes.length!==descriptor.size||!validSignature(bytes,descriptor.mimeType))throw fail('تعذر فتح الملف.',415);
    const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin'};
    if(kind==='photo'){
      if(!PHOTO_TYPES.includes(descriptor.mimeType))throw fail('صيغة الصورة غير مدعومة.',415);
      // Decode with a pixel limit, re-encode and remove EXIF/location metadata before display.
      const image=await sharp(bytes,{limitInputPixels:16000000,animated:false}).rotate().resize({width:800,height:800,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();
      return new Response(image,{headers:{...headers,'Content-Type':'image/webp'}});
    }
    return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':"attachment; filename=\"expert-cv.pdf\"; filename*=UTF-8''"+encodeURIComponent(descriptor.name)}});
  }catch(error){return serviceFailure(error);}
}
