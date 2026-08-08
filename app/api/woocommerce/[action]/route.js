import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

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
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(args),
    cache:'no-store'
  });
  const payload=await response.json().catch(()=>null);
  if(!response.ok){
    throw new Error(
      payload?.message
      ||payload?.error
      ||'تعذر تنفيذ عملية WooCommerce'
    );
  }
  return payload;
}

function translated(value){
  const raw=String(value||'');
  const messages={
    forbidden:'ليست لديك صلاحية لإدارة ربط WooCommerce.',
    authentication_required:'انتهت الجلسة. سجل الدخول مرة أخرى.',
    tenant_not_found:'المنشأة غير موجودة.',
    integration_addon_not_enabled:'إضافة WooCommerce غير مفعلة ضمن باقة المنشأة.',
    woocommerce_connection_not_found:'احفظ إعدادات WooCommerce أولًا.',
    woocommerce_credentials_required:'أدخل Consumer Key وConsumer Secret من WooCommerce.',
    woocommerce_store_https_required:'أدخل رابط HTTPS عامًا وصحيحًا لمتجر WordPress.',
    woocommerce_invalid_frequency:'جدول المزامنة غير صالح.',
    sync_time_invalid:'موعد المزامنة غير صالح.',
    sync_timezone_invalid:'المنطقة الزمنية للمزامنة غير صالحة.',
    woocommerce_invalid_scope:'اختيارات المزامنة غير صالحة.',
    woocommerce_sync_in_progress:'توجد مزامنة تعمل الآن. انتظر اكتمالها ثم حاول مجددًا.',
    woocommerce_previous_sync_failed:'فشلت المحاولة السابقة. أعد تشغيل المزامنة.',
    woocommerce_authentication_failed:'رفض WooCommerce المفاتيح. راجع صلاحية Consumer Key وSecret.',
    woocommerce_forbidden:'المفتاح لا يملك صلاحية قراءة البيانات المطلوبة.',
    woocommerce_not_found:'لم يُعثر على WooCommerce REST API في هذا الرابط.',
    woocommerce_rate_limited:'المتجر أوقف الطلبات مؤقتًا. أعد المحاولة بعد دقائق.',
    woocommerce_invalid_response:'استجابة المتجر غير صالحة أو محجوبة من الاستضافة.',
    woocommerce_connection_failed:'تعذر الوصول إلى المتجر. راجع الرابط والجدار الناري.',
    woocommerce_remote_http_401:'رفض WooCommerce المفاتيح. راجع Consumer Key وSecret.',
    woocommerce_remote_http_403:'المفتاح لا يملك صلاحية قراءة بيانات WooCommerce.',
    woocommerce_remote_http_404:'لم يُعثر على WooCommerce REST API في رابط المتجر.',
    woocommerce_remote_http_429:'المتجر أوقف الطلبات مؤقتًا. أعد المحاولة بعد دقائق.',
    woocommerce_remote_unavailable:'تعذر الوصول إلى المتجر. راجع الرابط والجدار الناري.',
    woocommerce_store_url_not_public:'يجب استخدام رابط HTTPS عام للمتجر.',
    woocommerce_public_https_url_required:'يجب استخدام رابط HTTPS عام للمتجر.',
    integration_connection_not_found:'احفظ إعدادات WooCommerce أولًا.',
    invalid_woocommerce_action:'عملية WooCommerce غير مدعومة.'
  };
  const code=Object.keys(messages).find(key=>raw.includes(key));
  return messages[code]
    ||'تعذر الاتصال بمتجر WooCommerce. راجع الرابط والمفاتيح ثم أعد الاختبار.';
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
    const tenantSlug=String(body.tenantSlug||'');

    if(action==='save'||action==='disable'){
      const data=await rpc(
        token,
        'v3_tenant_woocommerce_action',
        {
          p_tenant_slug:tenantSlug,
          p_action:action,
          p_payload:body.payload||{}
        }
      );
      return json({success:true,data});
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/woocommerce-sync`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          authorization:`Bearer ${token}`,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          tenantSlug,
          action:action==='test'?'test_connection':'sync_now'
        }),
        cache:'no-store'
      }
    );
    const payload=await response.json().catch(()=>null);
    if(!response.ok){
      return json(
        {error:translated(payload?.error),detail:payload},
        response.status
      );
    }
    return json({success:true,data:payload});
  }catch(error){
    return json({error:translated(error.message)},400);
  }
}
