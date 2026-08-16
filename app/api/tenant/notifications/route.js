import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_ACTIONS=new Set(['mark_read','mark_all_read']);

async function notificationRpc(token,body){
  const response=await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/v1_tenant_notification_center`,
    {
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:AbortSignal.timeout(6000)
    }
  );
  const text=await response.text();
  let payload;
  try{payload=JSON.parse(text)}catch{payload={message:text}}
  if(!response.ok){
    const error=new Error(payload?.message||'notification_request_failed');
    error.status=[400,401,403,404].includes(response.status)
      ?response.status
      :503;
    throw error;
  }
  return payload;
}

async function accessToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

function validSlug(value){
  return typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function errorResponse(error){
  const message=String(error?.message||'');
  const translated=message.includes('forbidden')
    ?'ليس لديك صلاحية لعرض هذه الإشعارات'
    :message.includes('tenant_not_found')
      ?'المنشأة غير موجودة'
      :'تعذر تحميل الإشعارات الآن';
  return NextResponse.json(
    {error:translated},
    {
      status:Number(error?.status)||503,
      headers:{'Cache-Control':'private, no-store'}
    }
  );
}

export async function GET(request){
  const token=await accessToken();
  if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
  const slug=new URL(request.url).searchParams.get('slug');
  if(!validSlug(slug)){
    return NextResponse.json({error:'معرّف المنشأة غير صالح'},{status:400});
  }
  try{
    const data=await notificationRpc(token,{
      p_tenant_slug:slug,
      p_action:'list',
      p_notification_id:null
    });
    return NextResponse.json({data});
  }catch(error){
    return errorResponse(error);
  }
}

export async function POST(request){
  const token=await accessToken();
  if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
  try{
    const body=await request.json();
    const slug=body?.slug;
    const action=body?.action;
    const notificationId=body?.notificationId||null;
    if(!validSlug(slug)||!WRITE_ACTIONS.has(action)){
      return NextResponse.json({error:'طلب الإشعار غير صالح'},{status:400});
    }
    if(action==='mark_read'&&!UUID_PATTERN.test(notificationId||'')){
      return NextResponse.json({error:'معرّف الإشعار غير صالح'},{status:400});
    }
    const data=await notificationRpc(token,{
      p_tenant_slug:slug,
      p_action:action,
      p_notification_id:notificationId
    });
    return NextResponse.json({data});
  }catch(error){
    return errorResponse(error);
  }
}
