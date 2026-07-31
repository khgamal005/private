import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const PROVIDERS=new Set(['salla','zid','shopify','custom']);
const ACTIONS=new Set(['save','disable','enable','test','sync']);

function json(body,status=200){
  return NextResponse.json(body,{status,headers:{'cache-control':'no-store'}});
}

async function userToken(){
  return (await cookies()).get(ACCESS_COOKIE)?.value||null;
}

async function rpc(token,args){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_tenant_commerce_hub_action`,{
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

function translated(value){
  const raw=String(value||'');
  const messages={
    forbidden:'ليست لديك صلاحية لإدارة تكاملات المتجر.',
    authentication_required:'انتهت الجلسة. سجل الدخول مرة أخرى.',
    tenant_not_found:'المنشأة غير موجودة.',
    integration_addon_not_enabled:'إضافة هذا المتجر غير مفعلة ضمن باقة المنشأة.',
    integration_connection_not_found:'احفظ إعدادات المتجر أولًا.',
    commerce_provider_not_supported:'منصة المتجر غير مدعومة.',
    commerce_use_woocommerce_connector:'استخدم لوحة WooCommerce الحالية لإدارة هذا الربط.',
    commerce_invalid_frequency:'جدول المزامنة غير صالح.',
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
    commerce_sync_failed:'تعذر تشغيل المزامنة.'
  };
  const key=Object.keys(messages).find(code=>raw.includes(code));
  return messages[key]||'تعذر حفظ ربط المتجر. راجع البيانات ثم أعد المحاولة.';
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
    if(action==='test'||action==='sync'){
      const data=await invokeCommerceSync(token,provider,action,tenantSlug,payload,request);
      return json({success:true,data});
    }
    const data=await rpc(token,{
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
