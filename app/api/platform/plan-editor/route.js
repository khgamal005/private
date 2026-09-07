import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {sameOrigin,boundedText} from '../../../../lib/tenant-controls-http.mjs';
import {planEditorPayload,validPlanEditorItem,planEditorError} from '../../../../lib/core-plan-editor.mjs';
export async function POST(request){
 try{
  if(!sameOrigin(request))return reply({success:false,error:'مصدر الطلب غير موثوق.'},403);
  const token=await accessToken();if(!token)return fail('authentication_required');
  if(!String(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return fail('plan_editor_payload_invalid');
  let body;try{body=JSON.parse(await boundedText(request,8*1024));}catch(e){return fail(e.message==='request_too_large'?e.message:'plan_editor_payload_invalid');}
  const payload=planEditorPayload(body);if(!payload)return fail('plan_editor_payload_invalid');
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v1_platform_core_plan_update`,{method:'POST',
   headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:JSON.stringify(payload),cache:'no-store',signal:AbortSignal.timeout(20000)});
  const result=JSON.parse(await boundedText(response,128*1024));
  if(!response.ok)return fail(response.status===401?'authentication_required':result?.message);
  if(!validPlanEditorItem(result,payload.p_plan_id))return fail('invalid_response');
  return reply({success:true,data:result});
 }catch{return fail('service_unavailable');}
}
function fail(code){const [status,error]=planEditorError(code);return reply({success:false,error},status);}
function reply(body,status=200){return NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-ODEIR-Feature':'plan-editor-v1','X-Content-Type-Options':'nosniff'}});}
