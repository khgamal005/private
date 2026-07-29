import {NextResponse} from 'next/server';
import {SUPABASE_KEY as PUBLISHABLE_KEY,SUPABASE_URL} from '../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const messages={
  assignments_required:'اختر موظفًا واحدًا على الأقل وحدد هدفه.',
  tiers_required:'أضف شريحة حافز واحدة على الأقل.',
  invalid_staff:'أحد الموظفين المختارين غير صالح أو غير نشط.',
  invalid_transition:'لا يمكن نقل الحافز إلى هذه الحالة الآن.',
  event_not_found:'سجل الحافز غير موجود.',
  plan_not_found:'خطة الحوافز غير موجودة.',
  forbidden:'ليست لديك صلاحية لتنفيذ هذا الإجراء.',
  authentication_required:'انتهت الجلسة. سجّل الدخول مرة أخرى.'
};

function json(body,status=200){
  return NextResponse.json(body,{status,headers:{'cache-control':'no-store'}});
}

function assertSupabaseConfiguration(){
  if(!SUPABASE_URL||!PUBLISHABLE_KEY){
    throw new Error('اتصال قاعدة بيانات المعاينة غير مكتمل. أعد المحاولة بعد لحظات.');
  }
}

function tokenFromValue(value){
  if(!value)return null;
  try{value=decodeURIComponent(value)}catch{}
  try{
    const parsed=JSON.parse(value);
    const candidate=Array.isArray(parsed)
      ?parsed[0]
      :parsed?.access_token||parsed?.currentSession?.access_token;
    if(typeof candidate==='string')return candidate;
  }catch{}
  return value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0]||null;
}

async function authContext(request){
  assertSupabaseConfiguration();
  const candidates=[
    request.cookies.get('mt_access')?.value,
    ...request.cookies.getAll().map(cookie=>tokenFromValue(cookie.value))
  ].filter(Boolean);
  for(const token of [...new Set(candidates)]){
    const response=await fetch(`${SUPABASE_URL}/auth/v1/user`,{
      headers:{apikey:PUBLISHABLE_KEY,authorization:`Bearer ${token}`},
      cache:'no-store'
    });
    if(response.ok){
      const user=await response.json();
      if(user?.id)return {token,user};
    }
  }
  return null;
}

async function rpc(token,name,args){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:PUBLISHABLE_KEY,
      authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(args),
    cache:'no-store'
  });
  const payload=await response.json().catch(()=>null);
  if(!response.ok){
    const raw=payload?.message||payload?.error||'تعذر تنفيذ العملية';
    throw new Error(messages[raw]||raw);
  }
  return payload;
}

export async function GET(request,{params}){
  try{
    const auth=await authContext(request);
    if(!auth)return json({error:'غير مصرح'},401);
    const {action}=await params;
    const slug=new URL(request.url).searchParams.get('tenantSlug');
    if(action!=='snapshot')return json({error:'غير موجود'},404);
    const [incentives,legacy]=await Promise.all([
      rpc(auth.token,'v2_tenant_incentives_snapshot',{p_slug:slug}),
      rpc(auth.token,'engagement_api_snapshot',{
        p_user_id:auth.user.id,
        p_tenant_slug:slug
      }).catch(()=>({announcements:[]}))
    ]);
    return json({...incentives,announcements:legacy?.announcements||[]});
  }catch(error){
    return json({error:error.message||'حدث خطأ'},500);
  }
}

export async function POST(request,{params}){
  try{
    const auth=await authContext(request);
    if(!auth)return json({error:'غير مصرح'},401);
    const {action}=await params;
    const body=await request.json().catch(()=>({}));
    if(['create-plan','plan-status','transition-event','sync'].includes(action)){
      const actionMap={
        'create-plan':'create_plan',
        'plan-status':'set_plan_status',
        'transition-event':'transition_event',
        sync:'sync'
      };
      return json(await rpc(auth.token,'v2_tenant_incentives_action',{
        p_slug:body.tenantSlug,
        p_action:actionMap[action],
        p_payload:body.payload||{}
      }));
    }
    if(action==='announcement'){
      return json(await rpc(auth.token,'engagement_api_create_announcement',{
        p_user_id:auth.user.id,p_tenant_slug:body.tenantSlug,p_type:body.type,
        p_priority:body.priority,p_title:body.title,p_body:body.body,
        p_starts_at:body.startsAt||null,p_ends_at:body.endsAt||null,
        p_requires_ack:!!body.requiresAck,p_is_pinned:!!body.isPinned
      }));
    }
    if(action==='read'){
      return json(await rpc(auth.token,'engagement_api_mark_read',{
        p_user_id:auth.user.id,p_announcement_id:body.announcementId,
        p_acknowledge:!!body.acknowledge
      }));
    }
    return json({error:'غير موجود'},404);
  }catch(error){
    return json({error:error.message||'حدث خطأ'},500);
  }
}
