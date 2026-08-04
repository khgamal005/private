import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

const MAX_BYTES=8*1024*1024;
const ALLOWED=new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const form=await request.formData();
    const file=form.get('file');
    const siteKey=String(form.get('siteKey')||'marktone-main').trim();
    const tenantSlug=String(form.get('tenantSlug')||'').trim()||null;
    const altText=String(form.get('altText')||'').trim();
    const caption=String(form.get('caption')||'').trim();
    if(!(file instanceof File))return NextResponse.json({error:'اختر صورة للرفع'},{status:400});
    if(file.size<1||file.size>MAX_BYTES)return NextResponse.json({error:'حجم الصورة يجب ألا يتجاوز 8 ميجابايت'},{status:413});
    if(!ALLOWED.has(file.type))return NextResponse.json({error:'يدعم الرفع JPG وPNG وWebP وGIF وAVIF فقط'},{status:415});

    const ticketResponse=await rpc('v3_cms_media_upload_ticket',token,{
      p_site_key:siteKey,p_tenant_slug:tenantSlug,p_file_name:file.name,
      p_mime_type:file.type,p_size_bytes:file.size
    });
    if(!ticketResponse.ok)return forwardError(ticketResponse);
    const ticket=await ticketResponse.json();
    const objectPath=ticket.objectPath;
    const uploadResponse=await fetch(`${SUPABASE_URL}/storage/v1/object/${ticket.bucket}/${objectPath}`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':file.type,'x-upsert':'false'},
      body:Buffer.from(await file.arrayBuffer()),
      cache:'no-store'
    });
    if(!uploadResponse.ok){
      const detail=await uploadResponse.text();
      return NextResponse.json({error:'تعذر رفع الصورة إلى مكتبة الوسائط',detail},{status:uploadResponse.status});
    }
    const publicUrl=`${SUPABASE_URL}/storage/v1/object/public/${ticket.bucket}/${objectPath}`;
    const registerResponse=await rpc('v3_cms_action',token,{
      p_site_key:siteKey,p_tenant_slug:tenantSlug,p_action:'register-asset',
      p_payload:{
        objectPath,publicUrl,fileName:file.name,mimeType:file.type,sizeBytes:file.size,
        altText:altText||file.name.replace(/\.[^.]+$/,''),caption
      }
    });
    if(!registerResponse.ok)return forwardError(registerResponse);
    const registered=await registerResponse.json();
    return NextResponse.json({success:true,asset:registered?.result||registered?.data?.result||registered});
  }catch(error){
    console.error('cms_media_upload_failed',error);
    return NextResponse.json({error:'تعذر رفع الصورة الآن',detail:error instanceof Error?error.message:String(error)},{status:500});
  }
}

function rpc(name,token,body){
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),cache:'no-store'
  });
}

async function forwardError(response){
  const text=await response.text();
  let data={};try{data=JSON.parse(text)}catch{data={detail:text}}
  const raw=String(data?.message||data?.error||data?.detail||'');
  const error=raw.includes('cms_addon_required')?'إضافة الموقع الاحترافي غير مفعلة':raw.includes('forbidden')?'ليس لديك صلاحية إدارة الوسائط':raw.includes('asset_too_large')?'حجم الصورة أكبر من الحد المسموح':raw.includes('asset_type_invalid')?'نوع الملف غير مدعوم':'تعذر رفع الصورة';
  return NextResponse.json({error,detail:data},{status:response.status});
}
