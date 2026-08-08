import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const PROVIDERS=new Set(['meta','google_ads','tiktok_ads','snapchat_ads','system']);
const ACTIONS=new Set([
  'save','disable','enable','test','sync','save-settings','insight-status'
]);

function json(body,status=200){
  return NextResponse.json(body,{status,headers:{'cache-control':'no-store'}});
}

async function token(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

async function rpc(accessToken,name,args){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${accessToken}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(args),
    cache:'no-store'
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok){
    throw new Error(result?.message||result?.error||'marketing_request_failed');
  }
  return result;
}

async function invokeSync(accessToken,provider,action,tenantSlug,payload,request){
  const response=await fetch(`${SUPABASE_URL}/functions/v1/ads-sync`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${accessToken}`,
      'content-type':'application/json',
      'x-idempotency-key':request.headers.get('x-idempotency-key')||crypto.randomUUID()
    },
    body:JSON.stringify({
      tenantSlug,
      provider,
      action:action==='test'?'test_connection':'sync_now',
      dateFrom:payload?.dateFrom||null,
      dateTo:payload?.dateTo||null
    }),
    cache:'no-store'
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error([result?.error,result?.detail].filter(Boolean).join(': ')||'marketing_sync_failed');
  return result;
}

function translated(value){
  const raw=String(value||'');
  const messages={
    forbidden:'ليست لديك صلاحية لإدارة مركز الحملات.',
    authentication_required:'انتهت الجلسة. سجل الدخول مرة أخرى.',
    tenant_not_found:'المنشأة غير موجودة.',
    marketing_addon_not_enabled:'إضافة مركز الحملات غير مفعلة ضمن باقة المنشأة.',
    marketing_connection_not_found:'احفظ إعدادات المنصة الإعلانية أولًا.',
    marketing_connection_test_required:'اختبر الاتصال قبل تشغيل المزامنة.',
    marketing_required_secret_missing:'بيانات الدخول المطلوبة غير مكتملة.',
    marketing_required_config_missing:'معرّف الحساب الإعلاني مطلوب.',
    marketing_google_oauth_credentials_missing:'أدخل Access Token أو بيانات Refresh Token الكاملة.',
    marketing_api_version_invalid:'إصدار API غير مدعوم لهذا الموصل.',
    marketing_sync_range_invalid:'الفترة المطلوبة غير صالحة أو أكبر من الحد المسموح.',
    marketing_sync_in_progress:'توجد مزامنة تعمل الآن لهذا الحساب.',
    business_management:'اتصال Meta يطلب صلاحية إدارية غير لازمة. حدّث الصفحة ثم أعد اختبار الاتصال.',
    remote_http_400:'رفضت منصة الإعلانات الطلب. راجع معرّف الحساب وصلاحيات رمز الوصول.',
    remote_http_401:'رمز الوصول منتهي أو غير صحيح. أعد التفويض ثم اختبر الاتصال.',
    remote_http_403:'الحساب لا يمنح صلاحية قراءة الحملات والتقارير.',
    remote_timeout:'انتهت مهلة اتصال منصة الإعلانات. أعد المحاولة.',
    remote_network_error:'تعذر الوصول إلى منصة الإعلانات مؤقتًا.',
    oauth_refresh_failed:'تعذر تجديد OAuth. راجع Refresh Token وبيانات التطبيق.',
    marketing_currency_invalid:'اختر عملة أساس صحيحة من ثلاثة أحرف.',
    marketing_timezone_invalid:'المنطقة الزمنية غير صحيحة.',
    sync_time_invalid:'موعد المزامنة غير صالح.',
    sync_timezone_invalid:'المنطقة الزمنية للمزامنة غير صالحة.',
    marketing_attribution_model_invalid:'نموذج الإسناد غير مدعوم.',
    marketing_snapshot_range_invalid:'فترة التقرير غير صالحة.',
    marketing_sync_failed:'تعذر إكمال مزامنة الحملات.'
  };
  const key=Object.keys(messages).find(code=>raw.includes(code));
  return messages[key]||'تعذر تنفيذ العملية. راجع البيانات والصلاحيات ثم أعد المحاولة.';
}

export async function POST(request,{params}){
  try{
    const {provider,action}=await params;
    if(!PROVIDERS.has(provider)||!ACTIONS.has(action)){
      return json({error:'غير موجود'},404);
    }
    const accessToken=await token();
    if(!accessToken)return json({error:'انتهت الجلسة'},401);
    const body=await request.json().catch(()=>({}));
    const tenantSlug=String(body.tenantSlug||'').trim();
    if(!tenantSlug)return json({error:'المنشأة غير محددة'},400);
    const payload=body.payload||{};

    if(action==='test'||action==='sync'){
      const data=await invokeSync(
        accessToken,provider,action,tenantSlug,payload,request
      );
      return json({success:true,data});
    }

    const actionName=action==='save-settings'
      ?'save_settings'
      :action==='insight-status'
        ?'insight_status'
        :action;
    const data=await rpc(accessToken,'v3_tenant_marketing_hub_action',{
      p_tenant_slug:tenantSlug,
      p_provider:provider==='system'?null:provider,
      p_action:actionName,
      p_payload:payload
    });
    return json({success:true,data});
  }catch(error){
    return json({error:translated(error.message)},400);
  }
}
