import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {WOO_BENEFICIARY_ERRORS} from '../../../../lib/woocommerce-beneficiaries.mjs';

const RPC=Object.freeze({search:'v1_tenant_woocommerce_beneficiary_search',save:'v1_tenant_woocommerce_save_beneficiaries',enroll:'v1_tenant_woocommerce_enroll_beneficiaries'});
const reply=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function boundedJSON(request){
  if(!request.body)throw new Error('invalid_body');
  const reader=request.body.getReader();let bytes=0;const chunks=[];
  try{
    while(true){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;if(bytes>65536){await reader.cancel();throw new Error('body_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(joined));
}
export async function POST(request){
  if(request.headers.get('sec-fetch-site')==='cross-site')return reply({error:'الطلب غير مسموح.'},403);
  if(!request.headers.get('content-type')?.includes('application/json'))return reply({error:'صيغة الطلب غير صالحة.'},415);
  const token=(await cookies()).get(ACCESS_COOKIE)?.value;
  if(!token)return reply({error:'انتهت الجلسة؛ سجل الدخول مرة أخرى.'},401);
  let body;
  try{body=await boundedJSON(request);}catch(error){return reply({error:'بيانات الطلب غير صالحة أو أكبر من المسموح.'},error.message==='body_too_large'?413:400);}
  if(!body||typeof body!=='object'||!Object.hasOwn(RPC,body.action)||typeof body.p_tenant_slug!=='string'||body.p_tenant_slug.length>100)
    return reply({error:'بيانات الطلب غير صالحة.'},400);
  const args={p_tenant_slug:body.p_tenant_slug};
  if(body.action==='search'){
    if(typeof body.p_query!=='string'||body.p_query.length>100)return reply({error:'نص البحث غير صالح.'},400);
    args.p_task_id=body.p_task_id;args.p_query=body.p_query;
  }else{
    args.p_expected_revision=body.p_expected_revision;args.p_command_id=body.p_command_id;
    if(body.action==='save'){args.p_task_id=body.p_task_id;args.p_lines=body.p_lines;}
    else{args.p_handoff_id=body.p_handoff_id;args.p_seats=body.p_seats;}
  }
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${RPC[body.action]}`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(args),cache:'no-store',signal:AbortSignal.timeout(20000)
    });
    const data=await response.json();
    if(!response.ok){
      const code=data?.message;
      return reply({error:WOO_BENEFICIARY_ERRORS[code]||(response.status===401?'انتهت الجلسة؛ سجل الدخول مرة أخرى.':'تعذر تنفيذ العملية. حدّث البيانات وأعد المحاولة.')},
        response.status===401?401:code==='forbidden'?403:code==='woocommerce_order_changed'?409:400);
    }
    return reply({success:true,data});
  }catch{return reply({error:'تعذر تأكيد نتيجة الحفظ. أعد المحاولة بنفس البيانات؛ لن يتكرر التسجيل.'},503);}
}
