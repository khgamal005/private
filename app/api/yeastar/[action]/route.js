import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';
import {yeastarErrorMessage} from '../../../../lib/yeastar-errors';

export const runtime='nodejs';
export const dynamic='force-dynamic';

function json(body,status=200){
  return NextResponse.json(body,{
    status,
    headers:{'cache-control':'no-store'}
  });
}

async function userToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

async function rpc(token,name,args){
  const request=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(args),
    cache:'no-store'
  });
  const payload=await request.json().catch(()=>null);
  if(!request.ok){
    throw new Error(payload?.message||payload?.error||'تعذر تنفيذ العملية');
  }
  return payload;
}

function translated(value){
  const raw=String(value||'');
  const code=raw.split(':')[0];
  const known=({
    forbidden:'ليست لديك صلاحية لإدارة ربط Yeastar.',
    tenant_not_found:'المنشأة غير موجودة.',
    integration_addon_not_enabled:'إضافة الربط الخارجي غير مفعلة ضمن الباقة.',
    yeastar_addon_not_enabled:'إضافة Yeastar المدفوعة غير مفعلة لهذه المنشأة.',
    integration_connection_not_found:'احفظ إعدادات Yeastar أولًا.',
    yeastar_public_https_required:'أدخل رابط HTTPS عامًا وصحيحًا لجهاز Yeastar.',
    yeastar_extension_required:'أدخل تحويلة واحدة على الأقل.',
    yeastar_too_many_extensions:'عدد التحويلات أكبر من الحد المسموح.',
    yeastar_invalid_timezone:'المنطقة الزمنية غير مدعومة.',
    yeastar_invalid_sync_interval:'فترة المزامنة غير صالحة.',
    yeastar_invalid_history_days:'عدد أيام السحب الأول يجب أن يكون من 1 إلى 90.',
    yeastar_invalid_extension_assignments:'صيغة ربط التحويلات بالموظفين غير صالحة.',
    yeastar_extension_mapping_not_configured:`التحويلة غير موجودة ضمن التحويلات المحفوظة: ${raw.split(':')[1]||''}`,
    yeastar_invalid_staff_assignment:'اختيار الموظف المرتبط بالتحويلة غير صالح.',
    yeastar_staff_not_found:'الموظف المحدد غير نشط أو لا يتبع هذه المنشأة.',
    yeastar_credentials_required:'أدخل Client ID وClient Secret من إعدادات API في Yeastar.',
    yeastar_extensions_not_found:`التحويلة غير موجودة على الجهاز: ${raw.split(':')[1]||''}`,
    yeastar_ip_forbidden:'رفض Yeastar عنوان الاتصال الحالي. يلزم تمرير الربط عبر عنوان خروج ثابت وإضافته إلى Allowed IPs.',
    yeastar_ip_blocked:'حظر Yeastar عنوان الاتصال بعد محاولات فاشلة. احذفه من Blocked IPs ثم أعد الاختبار عبر عنوان خروج ثابت.',
    yeastar_token_missing:'استجاب الجهاز دون رمز وصول.',
    authentication_required:'انتهت الجلسة. سجل الدخول مرة أخرى.',
    invalid_yeastar_action:'عملية Yeastar غير مدعومة.'
  })[code];
  if(known)return known;
  const friendly=yeastarErrorMessage(raw,'');
  return friendly&&friendly!==raw
    ?friendly
    :'تعذر الاتصال بـYeastar. راجع الرابط وبيانات API والسماح بالوصول الخارجي.';
}

export async function GET(request,{params}){
  try{
    const {action}=await params;
    if(action!=='settings')return json({error:'غير موجود'},404);
    const token=await userToken();
    if(!token)return json({error:'انتهت الجلسة'},401);
    const slug=new URL(request.url).searchParams.get('tenantSlug');
    const [settings,staffOptions]=await Promise.all([
      rpc(
        token,
        'v3_tenant_yeastar_settings_snapshot',
        {p_slug:slug}
      ),
      rpc(
        token,
        'v3_tenant_yeastar_staff_options',
        {p_slug:slug}
      ).catch(()=>[])
    ]);
    return json({...settings,staffOptions});
  }catch(error){
    return json({error:translated(error.message)},400);
  }
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!['save','disable','test','sync'].includes(action)){
      return json({error:'غير موجود'},404);
    }
    const token=await userToken();
    if(!token)return json({error:'انتهت الجلسة'},401);
    const body=await request.json().catch(()=>({}));

    if(['save','disable'].includes(action)){
      const procedure=action==='save'
        ?'v3_tenant_yeastar_save_with_assignments'
        :'v3_tenant_yeastar_action';
      const data=await rpc(token,procedure,{
        p_tenant_slug:body.tenantSlug,
        ...(action==='disable'?{p_action:action}:{}),
        p_payload:body.payload||{}
      });
      return json({success:true,data});
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/yeastar-sync`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          authorization:`Bearer ${token}`,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          tenantSlug:body.tenantSlug,
          action
        }),
        cache:'no-store'
      }
    );
    const payload=await response.json().catch(()=>null);
    if(!response.ok){
      return json({error:translated(payload?.error)},response.status);
    }
    return json(payload);
  }catch(error){
    return json({error:translated(error.message)},400);
  }
}
