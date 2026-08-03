import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=64*1024;

export async function POST(request){
  try{
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES){
      return NextResponse.json({error:'حجم الطلب أكبر من المسموح'},{status:413});
    }

    const body=await request.json();
    const name=clean(body?.name,120);
    const email=clean(body?.email,254).toLowerCase();
    const phone=clean(body?.phone,40);
    const organization=clean(body?.organization,160);
    const message=clean(body?.message,5000);
    const sourcePage=clean(body?.sourcePage,300)||'/';
    const website=clean(body?.website,200);
    const consent=Boolean(body?.consent);

    if(name.length<2){
      return NextResponse.json({error:'اكتب الاسم بشكل صحيح'},{status:400});
    }
    if(!email&&!phone){
      return NextResponse.json({error:'أضف البريد الإلكتروني أو رقم الجوال'},{status:400});
    }
    if(message.length<10){
      return NextResponse.json({error:'اكتب نبذة أوضح عن احتياج المؤسسة'},{status:400});
    }

    const ip=clientIp(request);
    const ipHash=ip?createHash('sha256')
      .update(`${process.env.CONTACT_IP_SALT||'marktone-public-contact'}:${ip}`)
      .digest('hex'):null;

    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_public_site_submit_contact`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${SUPABASE_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        p_name:name,
        p_email:email||null,
        p_phone:phone||null,
        p_organization:organization||null,
        p_message:message,
        p_source_page:sourcePage,
        p_ip_hash:ipHash,
        p_user_agent:clean(request.headers.get('user-agent'),500)||null,
        p_consent:consent,
        p_website:website||null
      }),
      cache:'no-store'
    });

    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}

    if(!response.ok){
      const messageKey=data?.message||data?.error||data?.detail||'';
      const status=String(messageKey).includes('rate_limited')?429:400;
      return NextResponse.json({error:translate(messageKey)},{status});
    }

    return NextResponse.json({
      success:true,
      reference:data?.reference||null,
      message:'تم استلام طلبك، وسيتواصل معك فريق ماركتون.'
    });
  }catch(error){
    console.error('public_contact_failed',error);
    return NextResponse.json({error:'تعذر إرسال الطلب الآن. حاول مرة أخرى.'},{status:500});
  }
}

function clean(value,max){
  return String(value??'').trim().slice(0,max);
}
function clientIp(request){
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ||request.headers.get('x-real-ip')?.trim()
    ||'';
}
function translate(value){
  const text=String(value||'');
  if(text.includes('contact_rate_limited'))return 'تم إرسال عدة طلبات متتالية. حاول بعد قليل.';
  if(text.includes('contact_email_invalid'))return 'البريد الإلكتروني غير صالح.';
  if(text.includes('contact_channel_required'))return 'أضف البريد الإلكتروني أو رقم الجوال.';
  if(text.includes('contact_message_invalid'))return 'اكتب نبذة أوضح عن احتياج المؤسسة.';
  if(text.includes('contact_name_invalid'))return 'اكتب الاسم بشكل صحيح.';
  return 'تعذر إرسال الطلب. راجع البيانات وحاول مرة أخرى.';
}
