import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});

    const body=await request.json().catch(()=>({}));
    const templateId=String(body?.templateId||'').trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(templateId)){
      return NextResponse.json({error:'معرّف القالب غير صالح'},{status:400});
    }

    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v3_cms_template_archive`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_template_id:templateId}),
      cache:'no-store'
    });
    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      const message=String(data?.message||data?.error||data?.detail||'');
      const status=response.status>=400&&response.status<500?response.status:502;
      return NextResponse.json({error:translate(message),detail:data},{status});
    }

    return NextResponse.json({
      success:true,
      templateId:data?.templateId||templateId,
      assetsRetained:data?.assetsRetained!==false,
      message:'تم حذف القالب من المكتبة مع إبقاء ملفاته لحماية الصفحات التي استخدمته.'
    });
  }catch(error){
    console.error('cms_template_archive_failed',error);
    return NextResponse.json({error:'تعذر حذف القالب من المكتبة'},{status:500});
  }
}

function translate(message){
  if(message.includes('authentication_required'))return 'انتهت جلسة الدخول';
  if(message.includes('template_not_found'))return 'القالب غير موجود أو سبق حذفه';
  if(message.includes('template_import_busy'))return 'القالب قيد المعالجة الآن. أعد المحاولة بعد لحظات.';
  if(message.includes('forbidden')||message.includes('permission'))return 'ليس لديك صلاحية حذف هذا القالب';
  return 'تعذر حذف القالب من المكتبة';
}
