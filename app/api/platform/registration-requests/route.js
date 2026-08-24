import {NextResponse} from 'next/server';
import {createHash} from 'node:crypto';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const MAX_BODY_BYTES=16*1024;
const MAX_DIRECTORY_RESPONSE_BYTES=128*1024;
const DIRECTORY_API='https://jultamrxwrgzohoktbgr.supabase.co/functions/v1/marktone-free-trial';
const TRUST_ACTIONS=new Set(['trust_start','trust_approve','trust_restrict']);
const ACTIONS=new Set([
  'start_review','approve','reject','reopen','provision',...TRUST_ACTIONS,
  'approve_and_activate'
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
    let payload=action==='provision'
      ?provisionPayload(body.payload)
      :action==='approve_and_activate'
        ?activationPayload(body.payload)
      :action==='reject'
        ?{category:clean(body.category,60)||null}
        :{};
    if(payload.error)return payload.error;

    const trustAction=TRUST_ACTIONS.has(action);
    if(action==='approve_and_activate'){
      const detailResult=await rpc(token,'v1_platform_registration_request_detail',{
        p_request_id:requestId
      });
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
        const externalAccountId=clean(valueOf(requestRow,[
          'externalAccountId','external_account_id','accountId','account_id'
        ]),64).toLowerCase();
        const institutionName=clean(valueOf(requestRow,[
          'institutionName','institution_name','organizationName','organization_name'
        ]),240);
        if(!isUuid(externalAccountId)){
          return jsonError(
            'تعذر التحقق من هوية المنشأة القائمة',
            'registration_external_account_required',
            409
          );
        }
        payload={
          ...payload,
          serverVerifiedExternalAccount:await verifyDirectoryInstitution({
            externalAccountId,
            institutionName
          })
        };
      }
    }
    const result=await rpc(
      token,
      trustAction
        ?'v1_platform_registration_trust_action'
        :action==='approve_and_activate'
          ?'v1_platform_registration_approve_and_activate'
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

function activationPayload(source){
  const body=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
  const resolution=clean(body.resolution,32).toLowerCase();
  if(!['create_new','link_existing'].includes(resolution)){
    return {error:jsonError(
      'اختر إنشاء مساحة مستقلة أو ربط مساحة قائمة',
      'registration_activation_resolution_required',
      400
    )};
  }
  if(resolution==='link_existing'){
    const targetTenantSlug=clean(body.targetTenantSlug,80).toLowerCase();
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetTenantSlug)){
      return {error:jsonError(
        'الرابط المختصر للمساحة القائمة غير صالح',
        'registration_target_tenant_invalid',
        400
      )};
    }
    return {
      resolution,
      identityVerified:true,
      confirmedNoExistingTenant:false,
      targetTenantSlug
    };
  }
  if(body.confirmedNoExistingTenant!==true){
    return {error:jsonError(
      'يلزم تأكيد عدم وجود مساحة أودير قائمة قبل الإنشاء',
      'registration_no_existing_tenant_confirmation_required',
      400
    )};
  }
  const provision=provisionPayload(body);
  if(provision.error)return provision;
  return {
    ...provision,
    resolution,
    identityVerified:true,
    confirmedNoExistingTenant:true,
    targetTenantSlug:null
  };
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

async function verifyDirectoryInstitution({externalAccountId,institutionName}){
  let response;
  try{
    response=await fetch(DIRECTORY_API,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'details',accountId:externalAccountId}),
      cache:'no-store',
      credentials:'omit',
      redirect:'error',
      referrerPolicy:'no-referrer',
      signal:AbortSignal.timeout(8_000)
    });
  }catch(error){
    throw new PublicError(
      'تعذر التحقق من سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
      'directory_verification_unavailable',
      503,
      error instanceof Error?error.name:'UnknownError'
    );
  }
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>MAX_DIRECTORY_RESPONSE_BYTES){
    throw new PublicError(
      'تعذر التحقق من سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
      'directory_verification_unavailable',
      503,
      'ResponseTooLarge'
    );
  }
  const raw=await response.text();
  if(Buffer.byteLength(raw,'utf8')>MAX_DIRECTORY_RESPONSE_BYTES){
    throw new PublicError(
      'تعذر التحقق من سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
      'directory_verification_unavailable',
      503,
      'ResponseTooLarge'
    );
  }
  let result={};
  try{result=raw?JSON.parse(raw):{};}catch{
    throw new PublicError(
      'تعذر التحقق من سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
      'directory_verification_unavailable',
      503,
      'InvalidJson'
    );
  }
  if(!response.ok){
    throw new PublicError(
      'تعذر التحقق من سجل المنشأة الآن؛ لم يُنفذ أي تفعيل',
      'directory_verification_unavailable',
      503,
      `Http${response.status}`
    );
  }
  const institution=result?.institution;
  if(result?.ok!==true||!institution
     ||Array.isArray(institution)||typeof institution!=='object'){
    throw new PublicError(
      'لم نتمكن من مطابقة المنشأة مع السجل الرسمي؛ راجع الطلب قبل التفعيل',
      'directory_identity_mismatch',
      409,
      'InstitutionMissing'
    );
  }
  const returnedId=clean(valueOf(institution,[
    'id','accountId','account_id','externalAccountId','external_account_id'
  ]),64).toLowerCase();
  const returnedName=clean(valueOf(institution,[
    'name','institutionName','institution_name','organizationName','organization_name'
  ]),240);
  if(returnedId!==externalAccountId
     ||!returnedName
     ||normalizeInstitutionName(returnedName)!==normalizeInstitutionName(institutionName)){
    throw new PublicError(
      'لم نتمكن من مطابقة المنشأة مع السجل الرسمي؛ راجع الطلب قبل التفعيل',
      'directory_identity_mismatch',
      409,
      'IdentityMismatch'
    );
  }
  const officialIdentifiers={
    commercialRegistration:officialIdentifier(valueOf(institution,[
      'commercialRegistration','commercial_registration','crNumber','cr_number'
    ])),
    nationalRegistration:officialIdentifier(valueOf(institution,[
      'nationalRegistration','national_registration','nationalNumber','national_number'
    ])),
    tvtcLicense:officialIdentifier(valueOf(institution,[
      'tvtcLicense','tvtc_license','tvtcLicenseNumber','tvtc_license_number',
      'trainingLicense','training_license'
    ]))
  };
  const canonicalEvidence={
    sourceSystem:'marktone_directory',
    accountId:externalAccountId,
    institutionName:normalizeInstitutionName(returnedName),
    officialIdentifiers
  };
  return {
    sourceSystem:'marktone_directory',
    accountId:externalAccountId,
    institutionName:returnedName,
    officialIdentifiers,
    evidenceHash:createHash('sha256')
      .update(JSON.stringify(canonicalEvidence),'utf8')
      .digest('hex')
  };
}

function registrationRequestOf(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const candidate=value.request||value.item||value.registrationRequest
    ||value.registration_request||value;
  return candidate&&typeof candidate==='object'&&!Array.isArray(candidate)
    ?candidate
    :null;
}

function normalizeInstitutionName(value){
  return clean(value,240)
    .toLocaleLowerCase('ar')
    .replace(/\s+/g,' ')
    .trim();
}

function officialIdentifier(value){
  const normalized=clean(value,80)
    .replace(/[٠-٩]/g,digit=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g,digit=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .toUpperCase()
    .replace(/\s+/g,'')
    .replace(/[^A-Z0-9._/-]/g,'');
  return normalized||null;
}

function valueOf(source,keys,fallback=''){
  for(const key of keys){
    const value=source?.[key];
    if(value!==undefined&&value!==null&&value!=='')return value;
  }
  return fallback;
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
  if(source.includes('conflict'))return 409;
  if(source.includes('transition_invalid')
     ||source.includes('already_provisioned')||source.includes('slug_exists')
     ||source.includes('domain_exists')||source.includes('_claimed')
     ||source.includes('_mismatch')
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
    registration_activation_resolution_required:'اختر إنشاء مساحة مستقلة أو ربط مساحة قائمة',
    registration_activation_resolution_invalid:'طريقة معالجة الطلب لا تطابق نوع المنشأة',
    registration_institution_state_invalid:'نوع طلب المنشأة غير صالح للتفعيل',
    registration_new_institution_link_invalid:'طلب المنشأة الجديدة لا يمكن ربطه بمساحة قائمة',
    registration_no_existing_tenant_confirmation_required:'يلزم تأكيد عدم وجود مساحة أودير قائمة قبل الإنشاء',
    registration_external_account_required:'تعذر التحقق من هوية المنشأة القائمة',
    registration_external_account_invalid:'معرّف المنشأة في السجل الرسمي غير صالح',
    registration_external_account_mismatch:'معرّف المنشأة لا يطابق الطلب المحفوظ',
    registration_external_account_already_claimed:'سجل المنشأة الرسمي مرتبط بالفعل بمساحة أخرى',
    registration_server_verification_required:'تعذر إثبات التحقق الخادمي من سجل المنشأة',
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
