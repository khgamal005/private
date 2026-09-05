// Platform-only, read-only credential probe. No checkout, Vault write or
// payment health transition is performed by this module.
const BASE_URLS=Object.freeze({
  sandbox:'https://api-sandbox.tamara.co',
  live:'https://api.tamara.co'
});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_KEYS=new Set(['environment','apiToken']);

const MESSAGES={
  forbidden:'ليس لديك صلاحية إدارة وسائل الدفع',
  unauthorized:'انتهت الجلسة؛ سجّل الدخول مجددًا',
  invalid_request:'أدخل API Token كاملًا وحدد بيئته الصحيحة',
  invalid_credentials:'لم تقبل تمارا المفتاح في هذه البيئة؛ راجع API Token وLive أو Sandbox',
  unsupported_media_type:'صيغة الطلب غير مدعومة',
  payload_too_large:'حجم البيانات أكبر من الحد المسموح',
  provider_unavailable:'تعذر الاتصال بتمارا الآن؛ أعد الاختبار لاحقًا',
  provider_response_invalid:'تعذر التحقق من رد تمارا؛ لم يُعتمد الاتصال',
  authorization_unavailable:'تعذر التحقق من صلاحياتك الآن؛ أعد المحاولة',
  origin_rejected:'تعذر التحقق من مصدر الطلب'
};

function json(body,status=200){
  return Response.json(body,{status,headers:{
    'Cache-Control':'private, no-store, max-age=0',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer'
  }});
}

function failure(code,status){
  return json({success:false,errorCode:code,error:MESSAGES[code]},status);
}

// The platform is served at odeir.com. Local development uses the request URL.
// Forwarded headers cannot select an arbitrary origin for a credential probe.
function sameOrigin(request){
  const site=request.headers.get('sec-fetch-site');
  if(site&&site!=='same-origin')return false;
  const origin=request.headers.get('origin');
  if(!origin)return false;
  try{
    const source=new URL(origin);
    if(source.origin!==origin)return false;
    const target=new URL(request.url);
    const forwarded=request.headers.get('x-forwarded-host');
    if(forwarded){
      return forwarded==='odeir.com'
        &&request.headers.get('x-forwarded-proto')==='https'
        &&origin==='https://odeir.com';
    }
    if(target.hostname==='localhost'||target.hostname==='127.0.0.1'){
      return source.origin===target.origin;
    }
    return target.origin==='https://odeir.com'&&origin===target.origin;
  }catch{return false;}
}

async function readJson(source,limit){
  if(!source.body)throw new Error('invalid_json');
  const reader=source.body.getReader();
  const chunks=[];
  let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit){
        await reader.cancel().catch(()=>{});
        throw new Error('payload_too_large');
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

async function fetchJson(fetchImpl,url,init,limit,timeoutMs){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{
      ...init,redirect:'error',cache:'no-store',signal:controller.signal
    });
    if(!response.ok){
      await response.body?.cancel().catch(()=>{});
      return {status:response.status,data:null};
    }
    const type=(response.headers.get('content-type')||'').split(';')[0].trim();
    if(type!=='application/json')throw new Error('invalid_content_type');
    return {status:response.status,data:await readJson(response,limit)};
  }finally{clearTimeout(timer);}
}

function validInput(body){
  return body&&typeof body==='object'&&!Array.isArray(body)
    &&Object.keys(body).every(key=>INPUT_KEYS.has(key))
    &&typeof body.environment==='string'
    &&Object.hasOwn(BASE_URLS,body.environment)
    &&typeof body.apiToken==='string'
    &&body.apiToken.length>=20&&body.apiToken.length<=8192
    &&/^[A-Za-z0-9._~+\/-]+=*$/.test(body.apiToken)
    &&!body.apiToken.includes('...');
}

// Pin to the response envelopes supported by Tamara's official PHP SDK.
// Return only a count; never reflect provider text or credentials to clients.
function paymentTypeCount(body){
  const types=Array.isArray(body)?body:body?.payment_types;
  if(!Array.isArray(types)||types.length>100)return null;
  if(types.some(type=>!type||typeof type!=='object'
    ||typeof type.name!=='string'||!type.name.trim()
    ||type.name.length>100))return null;
  return types.length;
}

export function createTamaraPreflight({
  supabaseUrl,supabaseKey,getAccessToken,fetchImpl=fetch,timeoutMs=8000
}){
  return async function POST(request){
    if(request.method!=='POST')return json({success:false},405);
    if(!sameOrigin(request))return failure('origin_rejected',403);
    if((request.headers.get('content-type')||'').split(';')[0].trim()
      !=='application/json')return failure('unsupported_media_type',415);
    let token;
    try{token=await getAccessToken();}catch{
      return failure('authorization_unavailable',503);
    }
    if(!token)return failure('unauthorized',401);
    let authorization;
    try{
      authorization=await fetchJson(fetchImpl,
        `${supabaseUrl}/rest/v1/rpc/v3_platform_payment_provider_admin_snapshot`,{
          method:'POST',headers:{apikey:supabaseKey,
            Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
          body:'{}'
        },64*1024,timeoutMs);
    }catch{return failure('authorization_unavailable',503);}
    if(authorization.status===401)return failure('unauthorized',401);
    if(authorization.status===403)return failure('forbidden',403);
    if(authorization.status!==200)return failure('authorization_unavailable',503);
    if(!UUID.test(String(authorization.data?.actorSubjectId||''))){
      return failure('forbidden',403);
    }
    let body;
    try{body=await readJson(request,12*1024);}catch(error){
      return error?.message==='payload_too_large'
        ?failure('payload_too_large',413):failure('invalid_request',400);
    }
    if(!validInput(body))return failure('invalid_request',400);
    let provider;
    try{
      provider=await fetchJson(fetchImpl,
        `${BASE_URLS[body.environment]}/checkout/payment-types?country=SA&currency=SAR`,{
          method:'GET',headers:{Authorization:`Bearer ${body.apiToken}`,
            Accept:'application/json'}
        },64*1024,timeoutMs);
    }catch{return failure('provider_unavailable',503);}
    if([401,403].includes(provider.status)){
      return failure('invalid_credentials',422);
    }
    if(provider.status!==200)return failure('provider_unavailable',503);
    const count=paymentTypeCount(provider.data);
    if(count===null)return failure('provider_response_invalid',502);
    return json({success:true,data:{
      providerKey:'tamara',environment:body.environment,
      apiVerified:true,paymentTypeCount:count,hasPaymentTypes:count>0,
      notificationVerified:false,checkoutReady:false,liveReady:false,
      credentialsSaved:false,checkedAt:new Date().toISOString()
    }});
  };
}
