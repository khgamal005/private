import {cookies} from 'next/headers';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {boundedJson} from '../../../../supabase/functions/_shared/tamara-protocol.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function POST(request){
 try{
  if(request.headers.get('origin')!=='https://odeir.com'||(request.headers.get('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin'))return json({error:'مصدر الطلب غير صالح'},403);
  const token=(await cookies()).get(ACCESS_COOKIE)?.value;if(!token)return json({error:'انتهت الجلسة'},401);
  const input=await boundedJson(request,2048,5000);
  const headers={apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  async function call(path,body={}){
   const response=await fetch(`${SUPABASE_URL}/${path}`,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
   if(!response.ok){await response.body?.cancel();throw new Error('runtime_unavailable');}
   if(response.status===204)return null;
   return boundedJson(response,32768,10000);
  }
  if(input.action==='prepare'){
   const id=await call('rest/v1/rpc/v1_platform_tamara_prepare_version');
   await call('functions/v1/tamara-setup',{versionId:id});
  }else if(input.action==='rollout'){
   if(!UUID.test(input.versionId)||!UUID.test(input.tenantId)||typeof input.enabled!=='boolean')return json({error:'بيانات غير صالحة'},400);
   await call('rest/v1/rpc/v1_platform_tamara_rollout',{p_version_id:input.versionId,p_tenant_id:input.tenantId,p_enabled:input.enabled});
  }else if(input.action!=='snapshot')return json({error:'طلب غير صالح'},400);
  return json(await call('rest/v1/rpc/v1_platform_tamara_runtime_snapshot'));
 }catch{return json({error:'لم يكتمل تجهيز تمارا. تحقّق من حالة الربط قبل إعادة المحاولة.'},503);}
}
