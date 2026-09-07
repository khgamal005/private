import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {UUID,sameOrigin,boundedText,controlPayload,validControlSnapshot,publicControlError} from '../../../../lib/tenant-controls-http.mjs';

export const maxDuration=30;
export async function GET(request){
  try{
    const token=await accessToken();if(!token)return fail('authentication_required');
    const id=new URL(request.url).searchParams.get('tenantId')||'';
    if(!UUID.test(id))return fail('tenant_controls_payload_invalid');
    const data=await rpc(token,'v1_platform_tenant_controls_snapshot',{p_tenant_id:id});
    if(!validControlSnapshot(data,id))return fail('invalid_rpc_response');
    return reply({success:true,data});
  }catch(error){return fail(error instanceof Error?error.message:'service_unavailable');}
}
export async function POST(request){
  try{
    if(!sameOrigin(request))return reply({success:false,error:'مصدر الطلب غير موثوق.',code:'request_origin_invalid'},403);
    const token=await accessToken();if(!token)return fail('authentication_required');
    let body;const text=await boundedText(request,8*1024);
    try{body=JSON.parse(text);}catch{return fail('tenant_controls_payload_invalid');}
    const payload=controlPayload(body);if(!payload)return fail('tenant_controls_payload_invalid');
    const data=await rpc(token,'v1_platform_tenant_controls_action',payload);
    if(!validControlSnapshot(data,payload.p_tenant_id)||typeof data.changed!=='boolean')return fail('invalid_rpc_response');
    return reply({success:true,data});
  }catch(error){return fail(error instanceof Error?error.message:'service_unavailable');}
}
async function rpc(token,name,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(20_000)
  });
  const text=await boundedText(response,128*1024);let value;
  try{value=JSON.parse(text);}catch{throw new Error('invalid_rpc_response');}
  if(!response.ok)throw new Error(response.status===401?'authentication_required':String(value?.message||'service_unavailable'));
  return value;
}
function fail(code){const [status,error]=publicControlError(code);return reply({success:false,error,code:status===503?'service_unavailable':code},status);}
function reply(value,status=200){return NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate','Vary':'Cookie','X-ODEIR-Feature':'tenant-controls-v1'}});}
