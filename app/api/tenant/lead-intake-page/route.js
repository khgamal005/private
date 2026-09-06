import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {presentLeadAssignments} from '../../../../lib/lead-distribution-mode.mjs';
import {
  parseLeadIntakePageRequest,validLeadIntakePage
} from '../../../../lib/lead-intake-page-contract.mjs';

const headers={'Cache-Control':'private, no-store, max-age=0'};
const json=(body,status=200)=>NextResponse.json(body,{status,headers});

export async function POST(request){
  const token=await accessToken();
  if(!token)return json({error:'انتهت الجلسة؛ سجّل الدخول مجددًا.'},401);
  let params;
  try{params=parseLeadIntakePageRequest(await request.json())}catch{}
  if(!params)return json({error:'معايير البحث أو نطاق التاريخ غير صالح.'},400);
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v1_tenant_lead_intake_page`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'},
      body:JSON.stringify(params),cache:'no-store',
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok){
      if(response.status===401)return json({error:'انتهت الجلسة؛ سجّل الدخول مجددًا.'},401);
      const failure=await response.json().catch(()=>({}));
      if(response.status===403||failure.message==='forbidden'){
        return json({error:'ليس لديك صلاحية لعرض سجل التوزيع.'},403);
      }
      if(failure.message==='tenant_not_found')return json({error:'المنشأة غير موجودة.'},404);
      if(String(failure.message||'').startsWith('invalid_')){
        return json({error:'معايير البحث أو نطاق التاريخ غير صالح.'},400);
      }
      return json({error:'تعذر تحميل السجل الآن. حاول مرة أخرى.'},503);
    }
    const data=await response.json();
    if(!validLeadIntakePage(data,params.p_section)
      ||(params.p_include_total&&data.total===null)){
      return json({error:'تعذر التحقق من نتائج السجل. حاول مرة أخرى.'},503);
    }
    if(data.section==='assignments')data.records=presentLeadAssignments(data.records);
    return json({data});
  }catch{
    return json({error:'تعذر تحميل السجل الآن. حاول مرة أخرى.'},503);
  }
}
