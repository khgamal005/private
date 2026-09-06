import {boundedJson,verifiedNotification} from './tamara-protocol.mjs';
import {makeProvider,processClaim,validContact} from './tamara-runtime.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9][a-z0-9_-]{0,119}$/;
const url=Deno.env.get('SUPABASE_URL')!;
const anon=Deno.env.get('SUPABASE_ANON_KEY')!;
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function rpcClient(token:string,apiKey:string=anon){return async(name:string,body:unknown={})=>{
  const response=await fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',headers:{apikey:apiKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  if(!response.ok){await response.body?.cancel();throw new Error('tamara_rpc_'+response.status);}
  if(response.status===204)return null;
  return boundedJson(response,262144,10000);
};}
async function authenticatedUser(token:string){
  const response=await fetch(`${url}/auth/v1/user`,{headers:{apikey:anon,Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok){await response.body?.cancel();return false;}
  const user=await boundedJson(response,32768,10000);
  return UUID.test(user?.id||'');
}
const rpc=rpcClient(service,service);
const provider=makeProvider();

export async function checkout(request:Request){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token)return json({error:'forbidden'},401);
  try{
    if(!await authenticatedUser(token))return json({error:'forbidden'},401);
    const input=await boundedJson(request,8192,5000);
    if(!SLUG.test(input?.slug)||!UUID.test(input?.orderId))return json({error:'invalid_input'},400);
    const contact=validContact(input.contact);
    if(!contact)return json({error:'tamara_contact_required'},422);
    const user=rpcClient(token);
    const prepared=await user('v1_tenant_tamara_prepare',{p_slug:input.slug,p_order_id:input.orderId});
    const claim=await rpc('v1_service_tamara_claim',{p_attempt_id:prepared.attemptId});
    if(claim)await processClaim(claim,{rpc,provider,contact});
    const status=await user('v1_tenant_tamara_status',{p_slug:input.slug,p_attempt_id:prepared.attemptId});
    return json(status,status.checkoutUrl?200:202);
  }catch{return json({error:'tamara_checkout_unavailable'},503);}
}
export async function webhook(request:Request){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  try{
    const input=await boundedJson(request,16384,5000);
    // Tamara's signed token authenticates the sender, not arbitrary body fields.
    // The worker always looks up the bound order before making any transition.
    const id=input?.order_reference_id;
    const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
      ||new URL(request.url).searchParams.get('tamaraToken');
    if(!UUID.test(id||'')||!token)return json({error:'invalid_notification'},401);
    const keys=await rpc('v1_service_tamara_notification_keys',{p_attempt_id:id});
    if(!keys||!await verifiedNotification(token,keys.notificationToken))return json({error:'invalid_notification'},401);
    await rpc('v1_service_tamara_wake',{p_attempt_id:id});
    // Acknowledge only after durable scheduling; delivery retries are harmless.
    return json({received:true});
  }catch{return json({error:'notification_unavailable'},503);}
}
export async function reconcile(request:Request){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const workerToken=request.headers.get('x-odeir-tamara-worker-token');
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token&&!workerToken)return json({error:'forbidden'},401);
  try{
    if(workerToken&&!await rpc('v1_service_tamara_worker_authenticated',{p_token:workerToken}))return json({error:'forbidden'},401);
    const caller=workerToken?rpc:rpcClient(token!);
    let processed=0;
    for(let i=0;i<5;i++){
      const claim=await caller('v1_service_tamara_claim',{});
      if(!claim)break;
      await processClaim(claim,{rpc,provider});processed++;
    }
    return json({processed});
  }catch{return json({error:'reconciliation_unavailable'},503);}
}

export async function setup(request:Request){
  let stage='authentication';
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token)return json({error:'forbidden'},401);
  try{
    if(!await authenticatedUser(token))return json({error:'forbidden'},401);
    stage='permission';
    const user=rpcClient(token);
    await user('v3_platform_payment_provider_admin_snapshot');
    const input=await boundedJson(request,2048,5000);
    const versionId=input.versionId;
    if(!UUID.test(versionId||''))return json({error:'invalid_input'},400);
    stage='credentials';
    const version=await rpc('v1_service_tamara_version',{p_version_id:versionId});
    if(!version)return json({error:'tamara_version_not_found'},404);
    let webhookId=version.webhook_id;
    if(!webhookId){
      stage='registration_claim';
      if(!await rpc('v1_service_tamara_claim_webhook',{p_version_id:versionId}))return json({error:'tamara_webhook_registration_pending'},409);
      stage='registration';
      const registered=await provider(version,'/webhooks',{
        url:`${url}/functions/v1/tamara-webhook`,
        events:['order_approved','order_authorised','order_captured','order_refunded','order_canceled','order_declined','order_expired'],headers:{}
      });
      webhookId=registered?.webhook_id;
      if(!UUID.test(webhookId||''))return json({error:'tamara_webhook_response_invalid'},502);
    }
    stage='verification';
    const confirmed=await provider(version,`/webhooks/${webhookId}`);
    if(confirmed?.webhook_id!==webhookId||confirmed?.url!==`${url}/functions/v1/tamara-webhook`)
      return json({error:'tamara_webhook_binding_invalid'},502);
    stage='binding';
    await rpc('v1_service_tamara_bind_webhook',{p_version_id:versionId,p_webhook_id:webhookId});
    stage='scheduling';
    await rpc('v1_service_tamara_schedule');
    return json({versionId,webhookVerified:true,enabled:false});
  }catch(error){const status=String(error?.message||'').match(/^tamara_rpc_(\d{3})$/)?.[1];return json({error:`tamara_setup_${stage}_failed${status?'_'+status:''}`},503);}
}
