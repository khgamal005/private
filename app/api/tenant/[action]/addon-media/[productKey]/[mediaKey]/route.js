import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../../../../lib/config';

const MAX_IMAGE_BYTES=8*1024*1024;
const PRODUCT_KEY=/^[a-z][a-z0-9_]{1,80}$/;
const MEDIA_KEY=/^[a-z][a-z0-9_.-]{2,100}$/;
const STORAGE_BUCKET=/^[a-z0-9][a-z0-9_-]{1,80}$/;

function failure(error,status){
  return NextResponse.json({error},{
    status,
    headers:{'cache-control':'no-store'}
  });
}

function storageObjectPath(value){
  const segments=String(value||'').split('/');
  if(!segments.length
     ||segments.some(segment=>!segment||segment==='.'||segment==='..')
     ||segments.join('/').length>1000){
    return null;
  }
  return segments.map(encodeURIComponent).join('/');
}

export async function GET(request,{params}){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return failure('انتهت الجلسة',401);
    const {action:slug,productKey,mediaKey}=await params;
    if(!PRODUCT_KEY.test(productKey)||!MEDIA_KEY.test(mediaKey)){
      return failure('الصورة غير موجودة',404);
    }

    const resolved=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v3_tenant_addon_media_resolve`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_slug:slug,
          p_product_key:productKey,
          p_media_key:mediaKey
        }),
        cache:'no-store'
      }
    );
    if(!resolved.ok){
      return failure(
        resolved.status===403?'ليس لديك صلاحية لعرض الصورة':'الصورة غير موجودة',
        resolved.status===401?401:resolved.status===403?403:404
      );
    }
    const media=await resolved.json();

    if(media.storageBucket&&media.storagePath){
      const bucket=String(media.storageBucket);
      const objectPath=storageObjectPath(media.storagePath);
      if(!STORAGE_BUCKET.test(bucket)||!objectPath){
        return failure('مسار الصورة غير صالح',404);
      }
      const object=await fetch(
        `${SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath}`,
        {
          headers:{
            apikey:SUPABASE_KEY,
            Authorization:`Bearer ${token}`
          },
          cache:'no-store'
        }
      );
      if(!object.ok)return failure('تعذر تحميل الصورة',object.status===404?404:502);
      const contentType=object.headers.get('content-type')||'';
      const declaredSize=Number(object.headers.get('content-length')||0);
      if(!contentType.startsWith('image/')
         ||(declaredSize>0&&declaredSize>MAX_IMAGE_BYTES)){
        return failure('ملف الصورة غير صالح',415);
      }
      const bytes=await object.arrayBuffer();
      if(bytes.byteLength>MAX_IMAGE_BYTES){
        return failure('حجم الصورة أكبر من الحد المسموح',413);
      }
      return new Response(bytes,{
        status:200,
        headers:{
          'content-type':contentType,
          'content-length':String(bytes.byteLength),
          'cache-control':'private, max-age=300',
          'x-content-type-options':'nosniff',
          'content-security-policy':"default-src 'none'"
        }
      });
    }

    if(media.externalUrl){
      const target=new URL(String(media.externalUrl));
      if(target.protocol!=='https:'||target.username||target.password){
        return failure('رابط الصورة غير صالح',404);
      }
      return new Response(null,{
        status:302,
        headers:{
          location:target.toString(),
          'cache-control':'private, max-age=300',
          'referrer-policy':'no-referrer',
          'x-content-type-options':'nosniff'
        }
      });
    }

    return failure('الصورة غير جاهزة',404);
  }catch{
    return failure('تعذر تحميل الصورة',500);
  }
}
