import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=16*1024;
const MAX_GATEWAY_RESPONSE_BYTES=128*1024;
const POST_DEADLINE_MS=28_000;
const ACTIVATION_GATEWAY=
  `${SUPABASE_URL}/functions/v1/odeir-registration-manual-activation`;
const PUBLIC_APP_URL=process.env.ODEIR_PUBLIC_APP_URL||'https://odeir.com';
const TRUST_ACTIONS=new Set(['trust_start','trust_approve','trust_restrict']);
const ACTIONS=new Set([
  'start_review','approve','reject','reopen','provision',...TRUST_ACTIONS,
  'approve_and_activate','move_to_manual_review','reissue_owner_invitation'
]);
const STATUSES=new Set([
  'pending_review','under_review','approved','rejected','converted',
  'awaiting_email','trust_pending','trust_review','trust_restricted',
  'manual_attention','trust_attention','restricted'
]);

export const maxDuration=30;

export async function GET(request){
  try{
    const token=await accessToken();
    if(!token)return jsonError('انتهت جلسة الدخول','authentication_required',401);
    const {searchParams}=request.nextUrl;
    const requestId=String(searchParams.get('id')||'').trim();
    if(requestId){
      if(!isUuid(requestId))return jsonError('معرّف الطلب غير صالح','invalid_request_id',400);
      const [result,delivery]=await Promise.all([
        rpc(token,'v1_platform_registration_request_detail',{
          p_request_id:requestId
        }),
        rpc(token,'v1_platform_registration_email_delivery_status',{
          p_request_id:requestId
        })
      ]);
      const data=result.data&&typeof result.data==='object'&&!Array.isArray(result.data)
        ?{...result.data,emailDelivery:delivery.data?.emailDelivery??null}
        :result.data;
      return privateJson({success:true,data},{status:result.status});
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
    return privateJson({success:true,data:result.data},{status:result.status});
  }catch(error){
    return unexpected(error);
  }
}

export async function POST(request){
  try{
    const deadlineAt=Date.now()+POST_DEADLINE_MS;
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

    const requiresReason=[
      'reject','reopen','trust_restrict','move_to_manual_review'
    ].includes(action);
    const notes=requiresReason
      ?clean(body.reason??body.notes,1200)
      :clean(body.notes??body.note,1200)||null;
    if(requiresReason&&String(notes||'').length<3){
      return jsonError('اكتب سببًا واضحًا للقرار','registration_reason_required',400);
    }
    let payload=action==='provision'
      ?provisionPayload(body.payload)
      :action==='approve_and_activate'
        ?activationPayload(body.payload)
      :action==='reject'
        ?{category:clean(body.category,60)||null}
        :{};
    if(payload.error)return payload.error;

    const trustAction=TRUST_ACTIONS.has(action);
    let delegatedActivation=null;
    if(action==='approve_and_activate'){
      const detailResult=await rpc(token,'v1_platform_registration_request_detail',{
        p_request_id:requestId
      },{deadlineAt,maxMs:5_000});
      const requestRow=registrationRequestOf(detailResult.data);
      if(!requestRow){
        return jsonError('طلب التسجيل غير موجود','registration_request_not_found',404);
      }
      const state=clean(valueOf(requestRow,[
        'institutionState','institution_state'
      ]),24).toLowerCase();
      const status=clean(valueOf(requestRow,['status','requestStatus','request_status']),32)
        .toLowerCase();
      const provisionedTenantId=clean(valueOf(requestRow,[
        'provisionedTenantId','provisioned_tenant_id','tenantId','tenant_id'
      ]),64);
      const completedReplay=status==='converted'&&isUuid(provisionedTenantId);
      if(!completedReplay&&!['new','existing'].includes(state)){
        return jsonError(
          'نوع طلب المنشأة غير صالح للتفعيل',
          'registration_institution_state_invalid',
          409
        );
      }
      if(!completedReplay&&state==='new'&&payload.resolution!=='create_new'){
        return jsonError(
          'طلب المنشأة الجديدة لا يمكن ربطه بمساحة قائمة',
          'registration_activation_resolution_invalid',
          400
        );
      }
      if(!completedReplay&&state==='existing'){
        delegatedActivation=await activateExistingInstitution(
          token,
          {requestId,expectedVersion,notes,payload},
          {deadlineAt,maxMs:21_000}
        );
      }
    }
    const result=delegatedActivation||await rpc(
      token,
      trustAction
        ?'v1_platform_registration_trust_action'
        :action==='approve_and_activate'
          ?'v1_platform_registration_approve_and_activate'
          :action==='reissue_owner_invitation'
            ?'v1_platform_registration_owner_invitation_reissue'
          :action==='move_to_manual_review'
            ?'v1_platform_registration_email_move_to_manual'
          :'v1_platform_registration_request_action',
      trustAction?{
        p_request_id:requestId,
        p_action:action,
        p_expected_version:expectedVersion,
        p_notes:notes
      }:action==='approve_and_activate'?{
        p_request_id:requestId,
        p_expected_version:expectedVersion,
        p_notes:notes,
        p_payload:payload
      }:action==='reissue_owner_invitation'?{
        p_request_id:requestId,
        p_expected_version:expectedVersion
      }:action==='move_to_manual_review'?{
        p_request_id:requestId,
        p_expected_version:expectedVersion,
        p_notes:notes
      }:{
        p_request_id:requestId,
        p_action:action,
        p_expected_version:expectedVersion,
        p_notes:notes,
        p_payload:payload
      },
      {deadlineAt,maxMs:9_000}
    );
    if(action==='approve_and_activate'&&!validActivationResult(result.data)){
      throw new PublicError(
        'تمت معالجة الطلب لكن تعذر التحقق من نتيجة التفعيل؛ أعد المحاولة بأمان',
        'registration_activation_response_invalid',503,'InvalidActivationResponse'
      );
    }
    if(
      action==='reissue_owner_invitation'
      &&!validOwnerInvitationReissueResult(result.data,requestId)
    ){
      throw new PublicError(
        'تمت معالجة الطلب لكن تعذر التحقق من رابط المالك؛ حدّث الطلب وأعد المحاولة بأمان',
        'registration_owner_invitation_response_invalid',503,
        'InvalidOwnerInvitationReissueResponse'
      );
    }
    const data=withInvitationUrl(result.data);
    return privateJson({success:true,data},{status:result.status});
  }catch(error){
    return unexpected(error);
  }
}

function activationPayload(source){
  const body=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
  const resolution=clean(body.resolution,32).toLowerCase();
  if(resolution!=='create_new'){
    return {error:jsonError(
      'التفعيل ينشئ مساحة مستقلة فقط؛ الربط بمساحة قائمة له مسار استحواذ منفصل',
      'registration_activation_resolution_required',
      400
    )};
  }
  if(body.confirmedNoExistingTenant!==true){
    return {error:jsonError(
      'يلزم تأكيد عدم وجود مساحة أودير قائمة قبل الإنشاء',
      'registration_no_existing_tenant_confirmation_required',
      400
    )};
  }
  if(body.identityVerified!==true){
    return {error:jsonError(
      'يلزم تأكيد مراجعة هوية المنشأة قبل التفعيل',
      'registration_identity_verification_required',
      400
    )};
  }
  const provision=provisionPayload(body);
  if(provision.error)return provision;
  return {
    ...provision,
    resolution,
    confirmedNoExistingTenant:true,
    identityVerified:true
  };
}

async function rpc(token,name,body,{deadlineAt=null,maxMs=20_000}={}){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store',
    signal:deadlineSignal(deadlineAt,maxMs)
  });
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={detail:text};}
  if(!response.ok){
    const source=String(data?.message||data?.error||data?.detail||'request_failed');
    throw new RpcError({
      source,
      status:translatedStatus(source,response.status),
      rpcName:name,
      databaseCode:String(data?.code||''),
      responseStatus:response.status
    });
  }
  return {data,status:response.status};
}

async function activateExistingInstitution(
  token,body,{deadlineAt=null,maxMs=21_000}={}
){
  let response;
  try{
    response=await fetch(ACTIVATION_GATEWAY,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'content-type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:deadlineSignal(deadlineAt,maxMs)
    });
  }catch(error){
    throw new PublicError(
      'تعذر الوصول إلى خدمة اعتماد المنشآت الآن؛ لم يُنفذ أي تفعيل',
      'registration_activation_gateway_unavailable',503,
      error instanceof Error?error.name:'UnknownError'
    );
  }
  let textValue;
  try{
    textValue=await boundedResponseText(response,MAX_GATEWAY_RESPONSE_BYTES);
  }catch{
    throw new PublicError(
      'استجابة خدمة اعتماد المنشآت غير صالحة؛ لم يُنفذ أي تفعيل',
      'registration_activation_gateway_invalid',503,'ResponseTooLarge'
    );
  }
  let data={};
  try{data=textValue?JSON.parse(textValue):{};}catch{
    throw new PublicError(
      'استجابة خدمة اعتماد المنشآت غير صالحة؛ لم يُنفذ أي تفعيل',
      'registration_activation_gateway_invalid',503,'InvalidJson'
    );
  }
  if(!response.ok||data?.ok!==true){
    const source=String(data?.error||data?.code||'registration_activation_gateway_unavailable');
    throw new RpcError({
      source,
      status:translatedStatus(source,response.status),
      rpcName:'odeir-registration-manual-activation',
      databaseCode:'',
      responseStatus:response.status
    });
  }
  if(!data.data||Array.isArray(data.data)||typeof data.data!=='object'){
    throw new PublicError(
      'استجابة خدمة اعتماد المنشآت غير صالحة؛ أعد المحاولة بأمان',
      'registration_activation_gateway_invalid',503,'MissingResult'
    );
  }
  return {data:data.data,status:response.status};
}

async function limitedBody(request){
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY_BYTES){
    return {error:jsonError('حجم الطلب أكبر من المسموح','request_too_large',413)};
  }
  const text=await boundedRequestText(request,MAX_BODY_BYTES);
  if(text===null){
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

async function boundedRequestText(request,maxBytes){
  if(!request.body)return '';
  const reader=request.body.getReader();
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
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

async function boundedResponseText(response,maxBytes){
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>maxBytes)throw new Error('response_too_large');
  if(!response.body)return '';
  const reader=response.body.getReader();
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel();
        throw new Error('response_too_large');
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

function registrationRequestOf(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const candidate=value.request||value.item||value.registrationRequest
    ||value.registration_request||value;
  return candidate&&typeof candidate==='object'&&!Array.isArray(candidate)
    ?candidate
    :null;
}

function valueOf(source,keys,fallback=''){
  for(const key of keys){
    const value=source?.[key];
    if(value!==undefined&&value!==null&&value!=='')return value;
  }
  return fallback;
}

function validActivationResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const requestRow=registrationRequestOf(value);
  const provisioning=value.provisioning;
  if(!requestRow||!provisioning||Array.isArray(provisioning)
     ||typeof provisioning!=='object')return false;
  const requestStatus=clean(valueOf(requestRow,[
    'status','requestStatus','request_status'
  ]),32).toLowerCase();
  const requestTenantId=clean(valueOf(requestRow,[
    'provisionedTenantId','provisioned_tenant_id','tenantId','tenant_id'
  ]),64).toLowerCase();
  const tenantId=clean(valueOf(provisioning,['id','tenantId','tenant_id']),64)
    .toLowerCase();
  const slug=clean(provisioning.slug,80).toLowerCase();
  return requestStatus==='converted'
    &&isUuid(requestTenantId)
    &&tenantId===requestTenantId
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    &&clean(provisioning.status,24).toLowerCase()==='active'
    &&clean(provisioning.resolution,24).toLowerCase()==='create_new';
}

function validOwnerInvitationReissueResult(value,requestId){
  if(!validActivationResult(value))return false;
  const requestRow=registrationRequestOf(value);
  const provisioning=value.provisioning;
  const owner=provisioning.owner;
  if(!owner||Array.isArray(owner)||typeof owner!=='object')return false;
  const responseRequestId=clean(valueOf(requestRow,['id','requestId','request_id']),64)
    .toLowerCase();
  const requestActivationMode=clean(valueOf(requestRow,[
    'activationMode','activation_mode'
  ]),32).toLowerCase();
  const tenantActivationMode=clean(valueOf(provisioning,[
    'activationMode','activation_mode'
  ]),32).toLowerCase();
  const ownerStatus=clean(owner.status,24).toLowerCase();
  const institutionName=clean(valueOf(provisioning,[
    'name','displayName','display_name'
  ]),240);
  const ownerName=clean(valueOf(owner,['name','fullName','full_name']),160);
  const ownerEmail=clean(owner.email,240).toLowerCase();
  const invitationToken=typeof owner.invitationToken==='string'
    ?owner.invitationToken.trim()
    :'';
  const hasSnakeToken=Object.prototype.hasOwnProperty.call(owner,'invitation_token');
  if(
    responseRequestId!==requestId.toLowerCase()
    ||requestActivationMode!=='manual_review'
    ||tenantActivationMode!=='manual_review'
    ||!['invited','linked'].includes(ownerStatus)
    ||institutionName.length<2
    ||ownerName.length<2
    ||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
    ||hasSnakeToken
  )return false;
  if(ownerStatus==='linked')return invitationToken==='';
  const invitationId=clean(valueOf(owner,['invitationId','invitation_id']),64);
  const invitationExpiresAt=Date.parse(String(valueOf(owner,[
    'invitationExpiresAt','invitation_expires_at'
  ],'')));
  return isUuid(invitationId)
    &&/^[0-9a-f]{64}$/i.test(invitationToken)
    &&Number.isFinite(invitationExpiresAt)
    &&invitationExpiresAt>Date.now();
}

function withInvitationUrl(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const provisioning=value.provisioning;
  const owner=provisioning?.owner;
  const token=typeof owner?.invitationToken==='string'
    ?owner.invitationToken.trim()
    :'';
  if(!owner||typeof owner!=='object'||Array.isArray(owner))return value;
  const safeOwner={...owner};
  delete safeOwner.invitationToken;
  delete safeOwner.invitation_token;
  const safeValue={
    ...value,
    provisioning:{...provisioning,owner:safeOwner}
  };
  if(!/^[0-9a-f]{64}$/i.test(token))return safeValue;
  const invitationUrl=new URL('/accept-invite',trustedPublicOrigin());
  invitationUrl.searchParams.set('token',token);
  return {
    ...safeValue,
    provisioning:{
      ...safeValue.provisioning,
      invitationUrl:invitationUrl.toString()
    }
  };
}

function trustedPublicOrigin(){
  try{
    const url=new URL(PUBLIC_APP_URL);
    const local=url.hostname==='localhost'||url.hostname==='127.0.0.1';
    if(
      !['odeir.com','www.odeir.com','staging.odeir.com'].includes(url.hostname)
      &&!local
    )throw new Error();
    if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw new Error();
    return url.origin;
  }catch{
    return 'https://odeir.com';
  }
}

function translatedStatus(source,fallback){
  if(source.includes('forbidden'))return 403;
  if(source.includes('not_found'))return 404;
  if(source.includes('conflict'))return 409;
  if(source.includes('transition_invalid')
     ||source.includes('already_provisioned')||source.includes('slug_exists')
     ||source.includes('domain_exists')||source.includes('_claimed')
     ||source.includes('_mismatch')
     ||source.includes('_revoked')||source.includes('_unavailable')
     ||source.includes('_inactive')||source.includes('identity_conflict')
     ||source.includes('_not_allowed')
     ||source.includes('atomic_activation')||source.includes('manual_activation'))return 409;
  if(Number(fallback)===401)return 401;
  if(source.includes('_invalid')||source.includes('_required')||source.includes('_missing')
     ||source.includes('plan_not_found'))return 400;
  return 503;
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
    registration_manual_activation_required:'هذا الطلب يتطلب مسار الاعتماد والتفعيل اليدوي الموحد',
    registration_atomic_activation_required:'استخدم إجراء «اعتماد وتفعيل» حتى لا يبقى الطلب في حالة ناقصة',
    registration_activation_target_missing:'تعذر تحديد مساحة المنشأة المستهدفة',
    registration_identity_verification_required:'يلزم تأكيد مراجعة هوية المنشأة',
    registration_activation_resolution_required:'هذا المسار ينشئ مساحة مستقلة فقط؛ ربط مساحة قائمة يتطلب إجراء استحواذ منفصلًا',
    registration_activation_resolution_invalid:'طريقة معالجة الطلب لا تطابق نوع المنشأة',
    registration_institution_state_invalid:'نوع طلب المنشأة غير صالح للتفعيل',
    registration_new_institution_link_invalid:'طلب المنشأة الجديدة لا يمكن ربطه بمساحة قائمة',
    registration_no_existing_tenant_confirmation_required:'يلزم تأكيد عدم وجود مساحة أودير قائمة قبل الإنشاء',
    registration_external_account_required:'تعذر التحقق من هوية المنشأة القائمة',
    registration_external_account_invalid:'معرّف المنشأة في السجل الرسمي غير صالح',
    registration_external_account_mismatch:'معرّف المنشأة لا يطابق الطلب المحفوظ',
    registration_external_account_already_claimed:'سجل المنشأة الرسمي مرتبط بالفعل بمساحة أخرى',
    registration_server_verification_required:'تعذر إثبات التحقق الخادمي من سجل المنشأة',
    registration_attestation_required:'انتهت أو لم تكتمل شهادة التحقق الخادمي؛ أعد المحاولة',
    registration_attestation_invalid:'شهادة التحقق الخادمي غير صالحة أو استُخدمت من قبل',
    registration_attestation_unavailable:'تعذر إكمال التحقق الخادمي الآن؛ لم يُنفذ أي تفعيل',
    registration_activation_gateway_unavailable:'خدمة اعتماد المنشآت غير متاحة الآن؛ لم يُنفذ أي تفعيل',
    registration_activation_gateway_invalid:'تعذر التحقق من استجابة خدمة الاعتماد؛ أعد المحاولة بأمان',
    directory_verification_unavailable:'تعذر الوصول إلى سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
    directory_identity_mismatch:'بيانات المنشأة لا تطابق السجل الرسمي؛ راجع الطلب قبل التفعيل',
    registration_operation_timeout:'انتهت مهلة التحقق؛ حدّث الطلب ثم أعد المحاولة بأمان',
    registration_operation_deadline_exceeded:'انتهت مهلة العملية قبل بدء خطوة جديدة؛ أعد المحاولة بأمان',
    registration_activation_response_invalid:'تعذر التحقق من نتيجة التفعيل؛ أعد المحاولة بأمان',
    registration_owner_invitation_reissue_not_allowed:'لا يمكن إصدار دعوة مالك من حالة الطلب أو المساحة الحالية',
    registration_owner_invitation_provenance_mismatch:'تعذر مطابقة الطلب بالمنشأة والمالك المسجلين بأمان',
    registration_owner_invitation_unavailable:'لا توجد دعوة مالك آمنة يمكن تجديدها؛ راجع المالك من «فريق العمل»',
    registration_owner_invitation_revoked:'دعوة المالك ملغاة إداريًا؛ راجع المالك من «فريق العمل» قبل إصدار وصول جديد',
    registration_owner_invitation_conflict:'تغيّرت دعوة المالك أثناء التنفيذ؛ حدّث الطلب ثم أعد المحاولة',
    registration_owner_identity_conflict:'يوجد مالك نشط مختلف عن المالك المسجل في الطلب؛ استخدم مسار إدارة الملكية',
    registration_owner_access_inactive:'حساب المالك كان مفعّلًا لكن عضويته أو صلاحية الملكية لم تعد نشطة؛ راجع «فريق العمل»',
    registration_owner_invitation_response_invalid:'تعذر التحقق من نتيجة إصدار دعوة المالك؛ حدّث الطلب وأعد المحاولة بأمان',
    registration_external_source_invalid:'مصدر سجل المنشأة غير معتمد',
    registration_external_institution_mismatch:'اسم المنشأة لا يطابق السجل الرسمي المحفوظ',
    registration_external_evidence_invalid:'بصمة دليل التحقق غير صالحة',
    registration_official_identifiers_invalid:'تعذر اعتماد المعرّفات الرسمية للمنشأة',
    registration_new_institution_external_account_invalid:'طلب المنشأة الجديدة يحتوي ارتباطًا رسميًا غير متوقع',
    registration_target_tenant_required:'حدد الرابط المختصر لمساحة أودير القائمة',
    registration_target_tenant_invalid:'الرابط المختصر للمساحة القائمة غير صالح',
    registration_target_tenant_not_found:'لم يتم العثور على مساحة أودير نشطة بهذا الرابط',
    registration_target_tenant_already_claimed:'المساحة القائمة مرتبطة بالفعل بطلب تسجيل آخر',
    registration_created_tenant_activation_failed:'تعذر إكمال تفعيل المساحة الجديدة؛ لم يُحفظ الطلب كمنشأة مفعّلة',
    registration_email_fallback_reason_required:'اكتب سببًا واضحًا لتحويل الطلب إلى المراجعة اليدوية',
    registration_email_fallback_not_allowed:'لا يمكن تحويل هذا الطلب إلى المراجعة اليدوية في حالته الحالية',
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
  if(error instanceof PublicError){
    console.error('platform_registration_directory_verification_failed',{
      publicCode:error.code,
      failureClass:error.failureClass
    });
    return jsonError(error.publicMessage,error.code,error.status);
  }
  if(error instanceof RpcError){
    console.error('platform_registration_rpc_failed',{
      rpcName:error.rpcName,
      databaseCode:error.databaseCode||'unknown',
      responseStatus:error.responseStatus,
      publicCode:error.code
    });
    return jsonError(translate(error.source),error.code,error.status);
  }
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)){
    console.error('platform_registration_operation_timeout',{
      errorName:error.name
    });
    return jsonError(
      'انتهت مهلة الاستجابة. حدّث الطلب قبل إعادة المحاولة؛ التكرار آمن ولن ينشئ مساحة ثانية.',
      'registration_operation_timeout',503
    );
  }
  console.error('platform_registration_request_failed',{
    errorName:error instanceof Error?error.name:'UnknownError'
  });
  return jsonError('تعذر تنفيذ العملية الآن','service_unavailable',503);
}

function jsonError(message,code,status){
  return privateJson({success:false,error:message,code},{status});
}

function privateJson(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate'
  );
  response.headers.set('CDN-Cache-Control','no-store');
  response.headers.set('Vercel-CDN-Cache-Control','no-store');
  response.headers.set('Pragma','no-cache');
  response.headers.set('Expires','0');
  response.headers.set('Referrer-Policy','no-referrer');
  return response;
}

function clean(value,max){
  return String(value??'').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);
}

function boundedInteger(value,min,max,fallback){
  const number=Number(value);
  return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;
}

function deadlineSignal(deadlineAt,maxMs){
  const remaining=deadlineAt===null
    ?maxMs
    :Math.floor(Number(deadlineAt)-Date.now());
  if(!Number.isFinite(remaining)||remaining<250){
    throw new PublicError(
      'انتهت مهلة العملية قبل بدء أي خطوة جديدة؛ أعد المحاولة بأمان',
      'registration_operation_deadline_exceeded',503,'DeadlineExceeded'
    );
  }
  return AbortSignal.timeout(Math.max(250,Math.min(maxMs,remaining)));
}

function isUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class RpcError extends Error{
  constructor({source,status,rpcName,databaseCode,responseStatus}){
    super(source);
    this.source=source;
    this.code=Object.keys({
      registration_request_conflict:1,
      registration_transition_invalid:1,
      registration_trust_transition_invalid:1,
      registration_trust_target_invalid:1,
      registration_activation_resolution_required:1,
      registration_activation_resolution_invalid:1,
      registration_institution_state_invalid:1,
      registration_manual_activation_required:1,
      registration_atomic_activation_required:1,
      registration_activation_target_missing:1,
      registration_identity_verification_required:1,
      registration_new_institution_link_invalid:1,
      registration_no_existing_tenant_confirmation_required:1,
      registration_external_account_required:1,
      registration_external_account_invalid:1,
      registration_external_account_mismatch:1,
      registration_external_account_already_claimed:1,
      registration_server_verification_required:1,
      registration_attestation_required:1,
      registration_attestation_invalid:1,
      registration_attestation_unavailable:1,
      registration_activation_gateway_unavailable:1,
      registration_activation_gateway_invalid:1,
      directory_verification_unavailable:1,
      directory_identity_mismatch:1,
      registration_operation_timeout:1,
      registration_operation_deadline_exceeded:1,
      registration_activation_response_invalid:1,
      registration_external_source_invalid:1,
      registration_external_institution_mismatch:1,
      registration_external_evidence_invalid:1,
      registration_official_identifiers_invalid:1,
      registration_new_institution_external_account_invalid:1,
      registration_target_tenant_required:1,
      registration_target_tenant_invalid:1,
      registration_target_tenant_not_found:1,
      registration_target_tenant_already_claimed:1,
      registration_created_tenant_activation_failed:1,
      registration_email_fallback_reason_required:1,
      registration_email_fallback_not_allowed:1,
      registration_request_not_found:1,
      forbidden:1
    }).find(code=>source.includes(code))||(status===503?'service_unavailable':'request_failed');
    this.status=status;
    this.rpcName=rpcName;
    this.databaseCode=databaseCode;
    this.responseStatus=responseStatus;
  }
}

class PublicError extends Error{
  constructor(publicMessage,code,status,failureClass){
    super(code);
    this.publicMessage=publicMessage;
    this.code=code;
    this.status=status;
    this.failureClass=failureClass;
  }
}
