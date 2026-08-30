import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_ACTIONS=new Set(['mark_read','mark_all_read','update_settings']);

async function accessToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

async function notificationRpc(token,functionName,body){
  const response=await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/${functionName}`,
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

function errorResponse(error){
  const message=String(error?.message||'');
  const translated=message.includes('forbidden')
    ?'ليس لديك صلاحية لعرض إشعارات المنصة'
    :message.includes('notification_capture_required')
      ?'فعّل التقاط الأحداث قبل البريد أو المراقبة التشغيلية'
      :message.includes('notification_locale_invalid')
        ?'لغة إشعارات المنصة غير صالحة'
    :message.includes('notification_not_found')
      ?'الإشعار غير موجود'
      :'تعذر تحميل إشعارات المنصة الآن';
  return NextResponse.json(
    {error:translated},
    {
      status:Number(error?.status)||503,
      headers:{'Cache-Control':'private, no-store'}
    }
  );
}

export async function GET(){
  const token=await accessToken();
  if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
  try{
    const data=await notificationRpc(
      token,
      'v1_platform_lifecycle_notification_center',{
      p_action:'list',
      p_notification_id:null
    });
    return NextResponse.json({data},{
      headers:{'Cache-Control':'private, no-store'}
    });
  }catch(error){
    return errorResponse(error);
  }
}

export async function POST(request){
  const token=await accessToken();
  if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});
  try{
    const body=await request.json();
    const action=body?.action;
    const notificationId=body?.notificationId||null;
    if(!WRITE_ACTIONS.has(action)){
      return NextResponse.json({error:'طلب الإشعار غير صالح'},{status:400});
    }
    if(action==='mark_read'&&!UUID_PATTERN.test(notificationId||'')){
      return NextResponse.json({error:'معرّف الإشعار غير صالح'},{status:400});
    }
    let data;
    if(action==='update_settings'){
      const settings=body?.settings;
      if(
        !settings||typeof settings!=='object'
        ||!['ar','en'].includes(settings.platformDefaultLocale)
        ||[
          'captureEnabled','tenantEmailEnabled','platformEmailEnabled',
          'operationalMonitorEnabled'
        ].some(key=>typeof settings[key]!=='boolean')
      ){
        return NextResponse.json({error:'إعدادات الإشعارات غير صالحة'},{status:400});
      }
      data=await notificationRpc(
        token,
        'v1_platform_lifecycle_notification_settings',{
          p_capture_enabled:settings.captureEnabled,
          p_tenant_email_enabled:settings.tenantEmailEnabled,
          p_platform_email_enabled:settings.platformEmailEnabled,
          p_operational_monitor_enabled:settings.operationalMonitorEnabled,
          p_platform_default_locale:settings.platformDefaultLocale
        }
      );
    }else{
      data=await notificationRpc(
        token,
        'v1_platform_lifecycle_notification_center',{
          p_action:action,
          p_notification_id:notificationId
        }
      );
    }
    return NextResponse.json({data},{
      headers:{'Cache-Control':'private, no-store'}
    });
  }catch(error){
    return errorResponse(error);
  }
}
