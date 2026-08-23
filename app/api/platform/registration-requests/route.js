import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=16*1024;
const TRUST_ACTIONS=new Set(['trust_start','trust_approve','trust_restrict']);
const ACTIONS=new Set([
  'start_review','approve','reject','reopen','provision',...TRUST_ACTIONS
]);
const STATUSES=new Set([
  'pending_review','under_review','approved','rejected','converted'
]);

export async function GET(request){
  try{
    const token=await accessToken();
    if(!token)return jsonError('انتهت جلسة الدخول','authentication_required',401);
    const {searchParams}=request.nextUrl;
    const requestId=String(searchParams.get('id')||'').trim();
    if(requestId){
      if(!isUuid(requestId))return jsonError('معرّف الطلب غير صالح','invalid_request_id',400);
      const result=await rpc(token,'v1_platform_registration_request_detail',{
        p_request_id:requestId
      });
      return NextResponse.json({success:true,data:result.data},{status:result.status});
    }

    const status=String(searchParams.get('status')||'').trim()||null;
    const query=String(searchParams.get('query')||'').trim()||null;
    const offset=boundedInteger(searchParams.get('offset'),0,100_000,0);
    const limit=boundedInteger(searchParams.get('limit'),1,50,25);
    if(status&&!STATUSES.has(status)){
      return jsonError('حالة الطلب غير صالحة','registration_status_invalid',400);
    }
    if(query&&query.length>80){
      return jsonError('عبارة البحث أطول من المسموح','registration_query_invalid',400);
    }
    const result=await rpc(token,'v1_platform_registration_requests_snapshot',{
      p_status:status,p_query:query,p_offset:offset,p_limit:limit
    });
    return NextResponse.json({success:true,data:result.data},{status:result.status});
  }catch(error){
    return unexpected(error);
  }
}

export async function POST(request){
  try{
    const token=await accessToken();
    if(!token)return jsonError('انتهت جلسة الدخول','authentication_required',401);
    const rawBody=await limitedBody(request);
    if(rawBody.error)return rawBody.error;
    const body=rawBody.value;
    const action=String(body.action||'').trim();
    const requestId=String(body.requestId||body.id||'').trim();
    const expectedVersion=Number(body.expectedVersion);
    if(!ACTIONS.has(action)){
      return jsonError('الإجراء المطلوب غير مدعوم','registration_action_invalid',400);
    }
    if(!isUuid(requestId)){
      return jsonError('معرّف الطلب غير صالح','invalid_request_id',400);
    }
    if(!Number.isInteger(expectedVersion)||expectedVersion<1){
      return jsonError(
        'تم تحديث الطلب؛ حدّث الصفحة ثم أعد المحاولة',
        'registration_request_conflict',
        409
      );
    }

    const requiresReason=['reject','reopen','trust_restrict'].includes(action);
    const notes=requiresReason
      ?clean(body.reason??body.notes,1200)
      :clean(body.notes??body.note,1200)||null;
    if(requiresReason&&String(notes||'').length<3){
      return jsonError('اكتب سببًا واضحًا للقرار','registration_reason_required',400);
    }
    const payload=action==='provision'
      ?provisionPayload(body.payload)
      :action==='reject'
        ?{category:clean(body.category,60)||null}
        :{};
    if(payload.error)return payload.error;

    const trustAction=TRUST_ACTIONS.has(action);
    const result=await rpc(
      token,
      trustAction
        ?'v1_platform_registration_trust_action'
        :'v1_platform_registration_request_action',
      trustAction?{
        p_request_id:requestId,
        p_action:action,
        p_expected_version:expectedVersion,
        p_notes:notes
      }:{
        p_request_id:requestId,
        p_action:action,
        p_expected_version:expectedVersion,
        p_notes:notes,
        p_payload:payload
      }
    );
    const data=withInvitationUrl(result.data,request);
    return NextResponse.json({success:true,data},{status:result.status});
  }catch(error){
    return unexpected(error);
  }
}

async function rpc(token,name,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store',
    signal:AbortSignal.timeout(10_000)
  });
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={detail:text};}
  if(!response.ok){
    const source=String(data?.message||data?.error||data?.detail||'request_failed');
    throw new RpcError(source,translatedStatus(source,response.status));
  }
  return {data,status:response.status};
}

async function limitedBody(request){
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY_BYTES){
    return {error:jsonError('حجم الطلب أكبر من المسموح','request_too_large',413)};
  }
  const text=await request.text();
  if(Buffer.byteLength(text,'utf8')>MAX_BODY_BYTES){
    return {error:jsonError('حجم الطلب أكبر من المسموح','request_too_large',413)};
  }
  try{
    const value=JSON.parse(text);
    if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();
    return {value};
  }catch{
    return {error:jsonError('بيانات الطلب غير صالحة','invalid_json',400)};
  }
}

function provisionPayload(source){
  const body=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
  const displayName=clean(body.displayName,240);
  const legalName=clean(body.legalName,240)||displayName;
  const slug=clean(body.slug,80).toLowerCase();
  const ownerName=clean(body.ownerName,160);
  const ownerEmail=clean(body.ownerEmail,240).toLowerCase();
  if(displayName.length<2){
    return {error:jsonError('اسم المنشأة مطلوب','display_name_required',400)};
  }
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)){
    return {error:jsonError('الرابط المختصر غير صالح','invalid_slug',400)};
  }
  if(ownerName.length<2){
    return {error:jsonError('اسم مالك المنشأة مطلوب','owner_name_required',400)};
  }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)){
    return {error:jsonError('بريد مالك المنشأة غير صالح','invalid_owner_email',400)};
  }
  return {
    displayName,
    legalName,
    slug,
    countryCode:clean(body.countryCode,2).toUpperCase()||'SA',
    timezone:clean(body.timezone,80)||'Asia/Riyadh',
    planKey:clean(body.planKey,80)||'free',
    ownerName,
    ownerEmail,
    hostname:clean(body.hostname,253).toLowerCase()||null
  };
}

function withInvitationUrl(value,request){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const provisioning=value.provisioning;
  const owner=provisioning?.owner;
  const token=typeof owner?.invitationToken==='string'
    ?owner.invitationToken
    :'';
  if(!token)return value;
  const invitationUrl=new URL('/accept-invite',request.nextUrl.origin);
  invitationUrl.searchParams.set('token',token);
  return {
    ...value,
    provisioning:{
      ...provisioning,
      owner:{...owner,invitationToken:undefined},
      invitationUrl:invitationUrl.toString()
    }
  };
}

function translatedStatus(source,fallback){
  if(source.includes('forbidden'))return 403;
  if(source.includes('not_found'))return 404;
  if(source.includes('conflict')||source.includes('transition_invalid')
     ||source.includes('already_provisioned')||source.includes('slug_exists')
     ||source.includes('domain_exists'))return 409;
  if(Number(fallback)===401)return 401;
  return 400;
}

function translate(source){
  const messages={
    forbidden:'ليس لديك صلاحية إدارة طلبات التسجيل',
    registration_request_not_found:'طلب التسجيل غير موجود',
    registration_request_conflict:'تم تحديث الطلب بواسطة مستخدم آخر؛ حدّث البيانات وأعد المحاولة',
    registration_transition_invalid:'لا يمكن تنفيذ هذا الإجراء على حالة الطلب الحالية',
    registration_rejection_reason_required:'اكتب سببًا واضحًا للرفض',
    registration_reopen_reason_required:'اكتب سببًا واضحًا لإعادة الفتح',
    registration_trust_transition_invalid:'لا يمكن تنفيذ قرار الموثوقية على حالة الطلب الحالية',
    registration_trust_reason_required:'اكتب سببًا واضحًا لتقييد المساحة',
    registration_trust_target_invalid:'تعذر مطابقة الطلب بالمساحة الجديدة بأمان',
    registration_trust_action_invalid:'إجراء الموثوقية غير مدعوم',
    registration_existing_institution_requires_manual_link:'المنشأة القائمة تحتاج تحققًا وربطًا يدويًا، ولن تُنشأ لها مساحة مكررة',
    registration_email_activation_managed:'هذا الطلب يتبع مسار تأكيد البريد ولا يقبل إجراءات التسجيل اليدوية',
    registration_identifier_already_provisioned:'هذه الهوية مرتبطة بمساحة منشأة أُنشئت مسبقًا',
    display_name_required:'اسم المنشأة مطلوب',
    invalid_slug:'الرابط المختصر غير صالح',
    slug_exists:'هذا الرابط المختصر مستخدم بالفعل',
    owner_name_required:'اسم مالك المنشأة مطلوب',
    invalid_owner_email:'بريد مالك المنشأة غير صالح',
    invalid_hostname:'الدومين غير صالح',
    domain_exists:'هذا الدومين مرتبط بمنشأة أخرى',
    plan_not_found:'الباقة غير موجودة أو غير مفعلة'
  };
  const key=Object.keys(messages).find(candidate=>source.includes(candidate));
  return key?messages[key]:'تعذر تنفيذ العملية الآن';
}

function unexpected(error){
  if(error instanceof RpcError){
    return jsonError(translate(error.source),error.code,error.status);
  }
  console.error('platform_registration_request_failed',{
    errorName:error instanceof Error?error.name:'UnknownError'
  });
  return jsonError('تعذر تنفيذ العملية الآن','service_unavailable',503);
}

function jsonError(message,code,status){
  return NextResponse.json({success:false,error:message,code},{status});
}

function clean(value,max){
  return String(value??'').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);
}

function boundedInteger(value,min,max,fallback){
  const number=Number(value);
  return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;
}

function isUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class RpcError extends Error{
  constructor(source,status){
    super(source);
    this.source=source;
    this.code=Object.keys({
      registration_request_conflict:1,
      registration_transition_invalid:1,
      registration_trust_transition_invalid:1,
      registration_trust_target_invalid:1,
      registration_request_not_found:1,
      forbidden:1
    }).find(code=>source.includes(code))||'request_failed';
    this.status=status;
  }
}
