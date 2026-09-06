import {boundedJson,checkoutUrl} from '../supabase/functions/_shared/tamara-protocol.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9][a-z0-9_-]{0,119}$/;
const STATES=new Set(['prepared','creating','pending','approved','authorised','provisioned','paid','cancelled','refunded','review_required']);
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export function tamaraGateway({getToken,url,key,fetcher=fetch}){
 return async(request,operation)=>{
  try{
   if(operation==='checkout'){
    const origin=request.headers.get('origin');
    const site=request.headers.get('sec-fetch-site');
    // Fixed production allowlist: never trust a forwarded host as an authority.
    const allowed=new Set(['https://odeir.com']);
    if(process.env.NODE_ENV!=='production')allowed.add(new URL(request.url).origin);
    if(!allowed.has(origin)||site&&site!=='same-origin')return json({error:'تعذر التحقق من مصدر الطلب'},403);
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return json({error:'طلب غير صالح'},415);
   }
   const token=await getToken();if(!token)return json({error:'انتهت الجلسة'},401);
   const input=operation==='checkout'?await boundedJson(request,8192,5000):Object.fromEntries(new URL(request.url).searchParams);
   if(!SLUG.test(input.slug)||!UUID.test(operation==='checkout'?input.orderId:input.attempt))return json({error:'طلب غير صالح'},400);
   const target=operation==='checkout'?`${url}/functions/v1/tamara-checkout`:`${url}/rest/v1/rpc/v1_tenant_tamara_status`;
   const body=operation==='checkout'?{slug:input.slug,orderId:input.orderId,contact:input.contact}:{p_slug:input.slug,p_attempt_id:input.attempt};
   const response=await fetcher(target,{method:'POST',redirect:'error',headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(45000)});
   if(!response.ok){await response.body?.cancel();return json({error:'تعذر فتح تمارا الآن. يمكنك متابعة الطلب من سجل الطلبات.'},response.status===422?422:503);}
   const data=await boundedJson(response,8192,10000);
   if(!UUID.test(data.attemptId)||!UUID.test(data.orderId)||!STATES.has(data.status))return json({error:'تعذر التحقق من حالة الدفع'},502);
   return json({attemptId:data.attemptId,orderId:data.orderId,orderNumber:String(data.orderNumber||'').slice(0,80),
    status:data.status,paymentStatus:data.paymentStatus,activationState:data.activationState,
    checkoutUrl:data.status==='pending'?checkoutUrl(data.checkoutUrl,data.environment):null},response.status===202?202:200);
  }catch{return json({error:'تأخر تأكيد الدفع. تابع نفس الطلب قبل بدء عملية أخرى.'},503);}
 };
}
