import {NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {SUPABASE_URL,SUPABASE_KEY,ACCESS_COOKIE} from '../../../../lib/config';
const RPC={
 'create-contact':'crm_create_contact','create-employee':'crm_create_employee','create-service':'crm_create_service',
 'create-opportunity':'crm_create_opportunity','move-opportunity':'crm_move_opportunity','create-task':'crm_create_task',
 'complete-task':'crm_complete_task','log-activity':'crm_log_activity','create-form':'crm_create_form',
 'set-form-status':'crm_set_form_status','create-support':'v2_support_create_request'
};
export async function POST(req,{params}){try{const {action}=await params,rpc=RPC[action];if(!rpc)return NextResponse.json({error:'عملية غير مدعومة'},{status:404});const token=(await cookies()).get(ACCESS_COOKIE)?.value;if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});const body=await req.json();const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`,{method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={detail:text}}if(!r.ok)return NextResponse.json({error:translate(data?.message||data?.detail||'تعذر تنفيذ العملية'),detail:data},{status:r.status});return NextResponse.json({success:true,data})}catch(e){return NextResponse.json({error:'تعذر تنفيذ العملية',detail:e.message},{status:500})}}
function translate(x){const m={forbidden:'ليس لديك صلاحية لتنفيذ العملية',next_action_required:'يجب تحديد الإجراء التالي وموعده',next_step_required:'يجب تحديد الخطوة التالية وموعدها',full_name_required:'الاسم مطلوب',name_required:'الاسم مطلوب',title_required:'العنوان مطلوب',invalid_contact:'العميل غير صالح',invalid_stage:'مرحلة المبيعات غير صالحة',invalid_slug:'الرابط المختصر غير صالح',form_not_found:'النموذج غير موجود',task_not_found:'المهمة غير موجودة',opportunity_not_found:'الفرصة غير موجودة'};return m[x]||String(x)}
