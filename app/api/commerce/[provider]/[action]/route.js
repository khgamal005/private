import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const PROVIDERS=new Set(['woocommerce','salla','zid','shopify','custom']);
const ACTIONS=new Set(['save','disable','enable','test','sync']);

function json(body,status=200){
  return NextResponse.json(body,{status,headers:{'cache-control':'no-store'}});
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
    throw new Error(payload?.message||payload?.error||'commerce_hub_request_failed');
  }
  return payload;
}

async function invokeCommerceSync(token,provider,action,tenantSlug,payload,request){
  const response=await fetch(`${SUPABASE_URL}/functions/v1/commerce-sync`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${token}`,
      'content-type':'application/json',
      'x-idempotency-key':request.headers.get('x-idempotency-key')||crypto.randomUUID()
    },
    body:JSON.stringify({
      tenantSlug,
      provider,
      action:action==='test'?'test_connection':'sync_now',
      scope:payload?.scope||null
    }),
    cache:'no-store'
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result?.error||'commerce_sync_failed');
  return result;
}

async function invokeWooCommerceSync(token,action,tenantSlug){
  const response=await fetch(`${SUPABASE_URL}/functions/v1/woocommerce-sync`,{
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
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result?.error||'woocommerce_connection_failed');
  return result;
}

function translated(value){
  const raw=String(value||'');
  const messages={
    forbidden:'ليست لديك صلاحية لإدارة تكاملات المتجر.',
    authentication_required:'انتهت الجلسة. سجل الدخول مرة أخرى.',
    tenant_not_found:'المنشأة غير موجودة.',
    integration_addon_not_enabled:'إضافة هذا المتجر غير مفعلة ضمن باقة المنشأة.',
    integration_connection_not_found:'احفظ إعدادات المتجر أولًا.',
    commerce_provider_not_supported:'منصة المتجر غير مدعومة.',
    commerce_invalid_frequency:'جدول المزامنة غير صالح.',
    sync_time_invalid:'موعد المزامنة غير صالح.',
    sync_timezone_invalid:'المنطقة الزمنية للمزامنة غير صالحة.',
    commerce_invalid_scope:'اختيارات المزامنة غير صالحة.',
    commerce_scope_not_supported_by_provider:'اختر فقط البيانات التي تدعمها منصة المتجر.',
    commerce_shopify_domain_invalid:'استخدم نطاق Shopify بصيغة your-store.myshopify.com.',
    commerce_public_https_url_required:'أدخل رابط HTTPS عامًا وآمنًا للمتجر.',
    commerce_custom_auth_type_invalid:'طريقة مصادقة المتجر المخصص غير صالحة.',
    commerce_required_config_missing:'بيانات تعريف المتجر غير مكتملة.',
    commerce_required_secret_missing:'رموز الوصول المطلوبة غير مكتملة.',
    commerce_secret_not_allowed:'تم إرسال مفتاح غير مسموح به.',
    invalid_commerce_hub_action:'عملية الربط غير مدعومة.',
    commerce_connection_test_required:'اختبر الاتصال قبل تشغيل المزامنة.',
    remote_http_401:'رمز الوصول غير صحيح أو منتهي.',
    remote_http_403:'رمز الوصول لا يملك الصلاحيات المطلوبة.',
    remote_timeout:'انتهت مهلة اتصال المتجر.',
    remote_network_error:'تعذر الوصول إلى المتجر.',
    commerce_sync_failed:'تعذر تشغيل المزامنة.',
    woocommerce_connection_not_found:'احفظ إعدادات WooCommerce أولًا.',
    woocommerce_credentials_required:'أدخل Consumer Key وConsumer Secret من WooCommerce.',
    woocommerce_store_https_required:'أدخل رابط HTTPS عامًا وصحيحًا لمتجر WordPress.',
    woocommerce_invalid_frequency:'جدول المزامنة غير صالح.',
    woocommerce_invalid_scope:'اختيارات المزامنة غير صالحة.',
    woocommerce_sync_in_progress:'توجد مزامنة تعمل الآن. انتظر اكتمالها ثم حاول مجددًا.',
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
    woocommerce_public_https_url_required:'يجب استخدام رابط HTTPS عام للمتجر.',
    invalid_woocommerce_action:'عملية WooCommerce غير مدعومة.'
  };
  const key=Object.keys(messages).find(code=>raw.includes(code));
  return messages[key]||'تعذر حفظ ربط المتجر. راجع البيانات ثم أعد المحاولة.';
}

async function handleWooCommerce({token,action,tenantSlug,payload}){
  if(action==='enable'){
    throw new Error('invalid_woocommerce_action');
  }
  if(action==='test'||action==='sync'){
    return invokeWooCommerceSync(token,action,tenantSlug);
  }
  return rpc(token,'v3_tenant_woocommerce_action',{
    p_tenant_slug:tenantSlug,
    p_action:action,
    p_payload:payload
  });
}

export async function POST(request,{params}){
  try{
    const {provider,action}=await params;
    if(!PROVIDERS.has(provider)||!ACTIONS.has(action)){
      return json({error:'غير موجود'},404);
    }
    const token=await userToken();
    if(!token)return json({error:'انتهت الجلسة'},401);
    const body=await request.json().catch(()=>({}));
    const tenantSlug=String(body.tenantSlug||'').trim();
    if(!tenantSlug)return json({error:'المنشأة غير محددة'},400);
    const payload=body.payload||{};

    if(provider==='woocommerce'){
      const data=await handleWooCommerce({
        token,
        action,
        tenantSlug,
        payload
      });
      return json({success:true,data});
    }

    if(action==='test'||action==='sync'){
      const data=await invokeCommerceSync(
        token,
        provider,
        action,
        tenantSlug,
        payload,
        request
      );
      return json({success:true,data});
    }

    const data=await rpc(token,'v2_tenant_commerce_hub_action',{
      p_tenant_slug:tenantSlug,
      p_provider:provider,
      p_action:action,
      p_payload:payload
    });
    return json({success:true,data});
  }catch(error){
    return json({error:translated(error.message)},400);
  }
}
