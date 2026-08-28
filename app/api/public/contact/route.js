import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=64*1024;
const EDGE_FUNCTION='odeir-contact-intake';

export async function POST(request){
  try{
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES){
      return NextResponse.json({ok:false,error:'حجم الطلب أكبر من المسموح'},{status:413});
    }

    const body=await request.json();
    const name=clean(body?.name,120);
    const email=clean(body?.email,254).toLowerCase();
    const phone=clean(body?.phone,40);
    const organization=clean(body?.organization,160);
    const topic=topicLabel(clean(body?.topic,40));
    const rawMessage=clean(body?.message,4600);
    const message=`[الموضوع: ${topic}]\n\n${rawMessage}`;
    const sourcePage=clean(body?.sourcePage,300)||'/contact';
    const website=clean(body?.website,200);
    const consent=body?.consent!==false;
    const startedAt=Number(body?.startedAt||0);

    if(website)return NextResponse.json({ok:true,success:true,ignored:true});
    if(startedAt&&Date.now()-startedAt<650){
      return NextResponse.json({ok:false,error:'invalid_session'},{status:400});
    }
    if(name.length<2)return NextResponse.json({ok:false,error:'اكتب الاسم بشكل صحيح'},{status:400});
    if(!email&&!phone)return NextResponse.json({ok:false,error:'أضف البريد الإلكتروني أو رقم الجوال'},{status:400});
    if(rawMessage.length<10)return NextResponse.json({ok:false,error:'اكتب نبذة أوضح عن احتياج المؤسسة'},{status:400});

    const ip=clientIp(request);
    const ipHash=ip?createHash('sha256')
      .update(`${process.env.CONTACT_IP_SALT||'marktone-public-contact'}:${ip}`)
      .digest('hex'):null;

    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_public_site_submit_contact`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        p_name:name,p_email:email||null,p_phone:phone||null,p_organization:organization||null,
        p_message:message,p_source_page:sourcePage,p_ip_hash:ipHash,
        p_user_agent:clean(request.headers.get('user-agent'),500)||null,
        p_consent:consent,p_website:null
      }),
      cache:'no-store'
    });

    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      const messageKey=data?.message||data?.error||data?.detail||'';
      const status=String(messageKey).includes('rate_limited')?429:400;
      return NextResponse.json({ok:false,error:translate(messageKey)},{status});
    }

    const reference=data?.reference||null;
    if(reference){
      try{
        const delivery=await fetch(`${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,{
          method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
          body:JSON.stringify({reference}),cache:'no-store',signal:AbortSignal.timeout(15_000)
        });
        if(!delivery.ok)console.error('public_contact_email_delivery_failed',{status:delivery.status,reference});
      }catch(error){
        console.error('public_contact_email_delivery_failed',{errorName:error instanceof Error?error.name:'UnknownError',reference});
      }
    }

    return NextResponse.json({ok:true,success:true,reference,message:'تم استلام طلبك، وسيتواصل معك فريق أودير.'});
  }catch(error){
    console.error('public_contact_failed',error);
    return NextResponse.json({ok:false,error:'تعذر إرسال الطلب الآن. حاول مرة أخرى.'},{status:500});
  }
}

function clean(value,max){return String(value??'').trim().slice(0,max);}
function clientIp(request){return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||request.headers.get('x-real-ip')?.trim()||'';}
function topicLabel(value){
  const map={support:'الدعم والتشغيل',sales:'المبيعات والاشتراكات',billing:'الفوترة والمدفوعات',integration:'التكاملات',privacy:'الخصوصية وحقوق البيانات',security:'أمن المعلومات',other:'موضوع آخر'};
  return map[value]||'طلب تواصل';
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
