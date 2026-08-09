import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';

const MAX_BYTES=20*1024*1024;
const ZIP_TYPES=new Set(['application/zip','application/x-zip-compressed']);

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const body=await request.json();
    const sizeBytes=Number(body?.sizeBytes||0);
    const mimeType=ZIP_TYPES.has(String(body?.mimeType||'').toLowerCase())
      ?String(body.mimeType).toLowerCase():'application/zip';
    const name=String(body?.name||'قالب مستورد').trim().replace(/\.zip$/i,'').slice(0,120)||'قالب مستورد';
    if(!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>MAX_BYTES){
      return NextResponse.json({error:'حجم ملف ZIP يجب ألا يتجاوز 20 ميجابايت'},{status:413});
    }
    const ticketResponse=await rpc('v3_cms_template_upload_ticket',token,{
      p_site_key:String(body?.siteKey||'marktone-main'),
      p_tenant_slug:body?.tenantSlug||null,
      p_name:name,p_mime_type:mimeType,p_size_bytes:sizeBytes
    });
    if(!ticketResponse.ok)return forward(ticketResponse,'تعذر تجهيز رفع القالب');
    const ticket=await ticketResponse.json();
    const signResponse=await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${encodePath(ticket.bucket)}/${encodePath(ticket.objectPath)}`,
      {method:'POST',headers:headers(token),body:'{}',cache:'no-store'}
    );
    if(!signResponse.ok)return forward(signResponse,'تعذر إنشاء رابط رفع آمن');
    const signed=await signResponse.json();
    if(!String(signed?.url||'').startsWith('/object/upload/sign/')){
      return NextResponse.json({error:'استجابة التخزين غير صالحة'},{status:502});
    }
    return NextResponse.json({
      templateId:ticket.templateId,
      uploadUrl:`${SUPABASE_URL}/storage/v1${signed.url}`,
      expiresIn:ticket.expiresIn||7200,
      maxBytes:ticket.maxBytes||MAX_BYTES
    });
  }catch(error){
    console.error('cms_template_ticket_failed',error);
    return NextResponse.json({error:'تعذر تجهيز استيراد القالب'},{status:500});
  }
}

function rpc(name,token,body){
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:headers(token),body:JSON.stringify(body),cache:'no-store'
  });
}
function headers(token){return {apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'}}
function encodePath(path){return String(path||'').split('/').map(encodeURIComponent).join('/')}
async function forward(response,fallback){
  const detail=await response.text();
  console.error('cms_template_ticket_upstream_failed',{status:response.status,detail:detail.slice(0,500)});
  return NextResponse.json({error:fallback},{status:response.status>=400&&response.status<500?response.status:502});
}
