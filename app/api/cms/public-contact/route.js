import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=64*1024;

export async function POST(request){
  try{
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES)return NextResponse.json({error:'حجم الطلب أكبر من المسموح'},{status:413});
    const body=await request.json();
    const name=clean(body?.name,120);
    const email=clean(body?.email,254).toLowerCase();
    const phone=clean(body?.phone,40);
    const organization=clean(body?.organization,160);
    const message=clean(body?.message,5000);
    const sourcePage=clean(body?.sourcePage,300)||'/';
    const website=clean(body?.website,200);
    const consent=Boolean(body?.consent);
    const siteKey=resolveSiteKey(body?.siteKey,sourcePage);
    if(name.length<2)return NextResponse.json({error:'اكتب الاسم بشكل صحيح'},{status:400});
    if(!email&&!phone)return NextResponse.json({error:'أضف البريد الإلكتروني أو رقم الجوال'},{status:400});
    if(message.length<10)return NextResponse.json({error:'اكتب نبذة أوضح عن احتياجك'},{status:400});
    const ip=clientIp(request);
    const ipHash=ip?createHash('sha256').update(`${process.env.CONTACT_IP_SALT||'marktone-cms-contact'}:${ip}`).digest('hex'):null;
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v3_cms_submit_contact`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        p_site_key:siteKey,p_name:name,p_email:email||null,p_phone:phone||null,
        p_organization:organization||null,p_message:message,p_source_page:sourcePage,
        p_ip_hash:ipHash,p_user_agent:clean(request.headers.get('user-agent'),500)||null,
        p_consent:consent,p_website:website||null
      }),
      cache:'no-store'
    });
    const text=await response.text();let data={};try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){const raw=String(data?.message||data?.error||data?.detail||'');return NextResponse.json({error:translate(raw)},{status:raw.includes('rate_limited')?429:400});}
    return NextResponse.json({success:true,reference:data?.reference||null,message:'تم استلام طلبك، وسيتواصل معك فريق العمل.'});
  }catch(error){
    console.error('cms_public_contact_failed',error);
    return NextResponse.json({error:'تعذر إرسال الطلب الآن. حاول مرة أخرى.'},{status:500});
  }
}

function resolveSiteKey(value,sourcePage){
  const explicit=String(value||'').trim();
  if(explicit)return explicit;
  const match=String(sourcePage||'').match(/^\/site\/([^/?#]+)/);
  return match?`tenant:${decodeURIComponent(match[1]).toLowerCase()}`:'marktone-main';
}
function clean(value,max){return String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max)}
function clientIp(request){return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||request.headers.get('x-real-ip')||''}
function translate(text){
  if(text.includes('contact_rate_limited'))return 'تم إرسال عدة طلبات مؤخرًا. حاول بعد قليل.';
  if(text.includes('contact_email_invalid'))return 'البريد الإلكتروني غير صحيح.';
  if(text.includes('contact_channel_required'))return 'أضف البريد الإلكتروني أو رقم الجوال.';
  if(text.includes('site_unavailable'))return 'الموقع غير متاح لاستقبال الطلبات حاليًا.';
  return 'راجع البيانات المدخلة وحاول مرة أخرى.';
}
