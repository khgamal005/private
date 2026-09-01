import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES=8*1024;
const MAX_UPSTREAM_BYTES=256*1024;
const RPC_TIMEOUT_MS=10_000;
const GLOBAL_ACTION_KEYS=new Set(['action','targetMode','confirmation']);
const GLOBAL_DISABLE_KEYS=new Set(['action','confirmation']);
const TENANT_ACTION_KEYS=new Set([
  'action','tenantId','environment','confirmation'
]);
const EVIDENCE_REQUEST_KEYS=new Set([
  'action','checkKey','artifactSha256','confirmation'
]);
const EVIDENCE_APPROVE_KEYS=new Set([
  'action','checkKey','artifactSha256','requestId','confirmation'
]);
const GLOBAL_ACTIONS=new Set(['global_request','global_approve']);
const TENANT_ACTIONS=new Set([
  'tenant_request','tenant_approve','tenant_disable'
]);
const PROVIDER_STATUSES=new Set([
  'disabled','draft','configured','active','error'
]);
const ROLLOUT_MODES=new Set(['observe_only','sandbox','live']);
const ENVIRONMENTS=new Set(['sandbox','live']);
// Only evidence produced outside the payment ledger can enter the
// maker/checker attestation flow. Intention, callback, settlement, duplicate,
// inquiry and refund-result checks are derived by SQL and are never writable
// from this operator endpoint.
const EVIDENCE_CHECKS=new Set([
  'refund_initiation','live_credentials','live_card_integration_callback',
  'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
]);

export async function GET(request){
  try{
    if(!sameOrigin(request)){
      return json({error:'تعذر التحقق من مصدر الطلب'},{status:403});
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});
    const result=await callerRpc(
      token,'v1_platform_paymob_readiness_snapshot',{},MAX_UPSTREAM_BYTES
    );
    const snapshot=sanitizeSnapshot(result.value);
    if(!result.response.ok){
      return rpcError(result.response.status,result.value);
    }
    if(!snapshot){
      return json({error:'تعذر التحقق من جاهزية Paymob'},{status:502});
    }
    return json({success:true,data:snapshot});
  }catch(error){
    return unavailable(error,'تعذر تحميل حوكمة Paymob');
  }
}

export async function POST(request){
  try{
    if(!sameOrigin(request)){
      return json({error:'تعذر التحقق من مصدر الطلب'},{status:403});
    }
    const contentType=String(request.headers.get('content-type')||'')
      .split(';',1)[0].trim().toLowerCase();
    if(contentType!=='application/json'){
      return json({error:'نوع بيانات الطلب غير مدعوم'},{status:415});
    }
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});
    const inbound=await readTextLimited(request,MAX_REQUEST_BYTES);
    if(inbound.tooLarge){
      return json({error:'بيانات الإجراء أكبر من الحد المسموح'},{status:413});
    }
    let input;
    try{input=JSON.parse(inbound.text)}catch{
      return json({error:'بيانات الإجراء غير صالحة'},{status:400});
    }
    const action=normalizeAction(input);
    if(!action){
      return json({error:'نص التأكيد أو بيانات الإجراء غير مطابقة'},{status:400});
    }

    const result=await callerRpc(
      token,action.rpc,action.body,32*1024
    );
    if(!result.response.ok){
      return rpcError(result.response.status,result.value);
    }
    const data=action.kind==='global'
      ?sanitizeGlobalAction(result.value)
      :action.kind==='tenant'
        ?sanitizeTenantAction(result.value)
        :sanitizeEvidenceAction(result.value);
    if(!data){
      return json({error:'تعذر التحقق من نتيجة إجراء Paymob'},{status:502});
    }
    return json({success:true,data});
  }catch(error){
    return unavailable(error,'تعذر تنفيذ إجراء Paymob');
  }
}

function normalizeAction(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const action=String(value.action||'');
  if(GLOBAL_ACTIONS.has(action)){
    if(!hasExactKeys(value,GLOBAL_ACTION_KEYS))return null;
    const targetMode=String(value.targetMode||'');
    if(!ENVIRONMENTS.has(targetMode))return null;
    const verb=action==='global_request'?'REQUEST':'APPROVE';
    const expected=`${verb} PAYMOB ${targetMode.toUpperCase()}`;
    if(value.confirmation!==expected)return null;
    return {
      kind:'global',
      rpc:'v1_platform_paymob_activation_gate',
      body:{p_target_mode:targetMode,p_confirmation:expected}
    };
  }
  if(action==='global_disable'){
    if(!hasExactKeys(value,GLOBAL_DISABLE_KEYS)
       ||value.confirmation!=='DISABLE PAYMOB CHECKOUT')return null;
    return {
      kind:'global',
      rpc:'v1_platform_paymob_activation_gate',
      body:{
        p_target_mode:'observe_only',
        p_confirmation:'DISABLE PAYMOB CHECKOUT'
      }
    };
  }
  if(TENANT_ACTIONS.has(action)){
    if(!hasExactKeys(value,TENANT_ACTION_KEYS))return null;
    const tenantId=String(value.tenantId||'');
    const environment=String(value.environment||'');
    if(!UUID.test(tenantId)||!ENVIRONMENTS.has(environment))return null;
    const enabled=action!=='tenant_disable';
    const verb=action==='tenant_request'
      ?'REQUEST'
      :action==='tenant_approve'?'APPROVE':'DISABLE';
    const expected=enabled
      ?`${verb} PAYMOB TENANT ${tenantId} ${environment.toUpperCase()}`
      :`DISABLE PAYMOB TENANT ${tenantId}`;
    if(value.confirmation!==expected)return null;
    return {
      kind:'tenant',
      rpc:'v1_platform_paymob_tenant_rollout_action',
      body:{
        p_tenant_id:tenantId,
        p_environment:environment,
        p_enabled:enabled,
        p_confirmation:expected
      }
    };
  }
  if(action==='evidence_request'){
    if(!hasExactKeys(value,EVIDENCE_REQUEST_KEYS))return null;
    const checkKey=String(value.checkKey||'');
    const artifactSha256=String(value.artifactSha256||'');
    const expected=`REQUEST PAYMOB EVIDENCE ${checkKey}`;
    if(!EVIDENCE_CHECKS.has(checkKey)
       ||!/^[a-f0-9]{64}$/.test(artifactSha256)
       ||value.confirmation!==expected)return null;
    return {
      kind:'evidence',
      rpc:'v1_platform_paymob_operational_evidence_action',
      body:{
        p_check_key:checkKey,p_evidence_sha256:artifactSha256,
        p_request_id:null,p_confirmation:expected
      }
    };
  }
  if(action==='evidence_approve'){
    if(!hasExactKeys(value,EVIDENCE_APPROVE_KEYS))return null;
    const checkKey=String(value.checkKey||'');
    const artifactSha256=String(value.artifactSha256||'');
    const requestId=String(value.requestId||'');
    const expected=`APPROVE PAYMOB EVIDENCE ${requestId}`;
    if(!EVIDENCE_CHECKS.has(checkKey)||!UUID.test(requestId)
       ||!/^[a-f0-9]{64}$/.test(artifactSha256)
       ||value.confirmation!==expected)return null;
    return {
      kind:'evidence',
      rpc:'v1_platform_paymob_operational_evidence_action',
      body:{
        p_check_key:checkKey,p_evidence_sha256:artifactSha256,
        p_request_id:requestId,p_confirmation:expected
      }
    };
  }
  return null;
}

async function callerRpc(token,name,body,maxBytes){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    redirect:'error',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json',
      Accept:'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store',
    signal:AbortSignal.timeout(RPC_TIMEOUT_MS)
  });
  const upstream=await readTextLimited(response,maxBytes);
  if(upstream.tooLarge)throw new Error('upstream_response_too_large');
  let value;
  try{value=JSON.parse(upstream.text)}catch{
    throw new Error('upstream_response_invalid');
  }
  return {response,value};
}

function sanitizeSnapshot(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
     ||value.schemaVersion!==1||value.providerKey!=='paymob')return null;
  const status=safeEnum(value.status,PROVIDER_STATUSES);
  const environment=safeEnum(value.environment,ENVIRONMENTS);
  const credentialsEnvironment=safeEnum(
    value.credentialsEnvironment,ENVIRONMENTS
  );
  const rolloutMode=safeEnum(value.rolloutMode,ROLLOUT_MODES);
  if(!status||!environment||!credentialsEnvironment||!rolloutMode)return null;
  const tenantRollouts=sanitizeTenantRollouts(value.tenantRollouts);
  if(tenantRollouts===null)return null;
  const operationalEvidenceRequests=sanitizeOperationalEvidenceRequests(
    value.operationalEvidenceRequests
  );
  if(operationalEvidenceRequests===null)return null;
  return {
    schemaVersion:1,
    providerKey:'paymob',
    status,
    environment,
    credentialsEnvironment,
    rolloutMode,
    configured:value.configured===true,
    active:value.active===true,
    nativeAdapterDeployed:value.nativeAdapterDeployed===true,
    verifiedAt:safeDate(value.verifiedAt),
    requiredChecks:safeCodes(value.requiredChecks),
    passedChecks:safeCodes(value.passedChecks),
    missingChecks:safeCodes(value.missingChecks),
    sandboxReady:value.sandboxReady===true,
    liveReady:value.liveReady===true,
    liveGateBlocked:value.liveGateBlocked!==false,
    webhookVerified:value.webhookVerified===true,
    reconciliationVerified:value.reconciliationVerified===true,
    refundVerified:value.refundVerified===true,
    credentialRotationVerified:value.credentialRotationVerified===true,
    queryLogRedactionVerified:value.queryLogRedactionVerified===true,
    lastErrorCode:safeCode(value.lastErrorCode),
    pendingActivation:value.pendingActivation===true,
    pendingActivationMode:safeEnum(
      value.pendingActivationMode,ENVIRONMENTS
    ),
    enabledSandboxTenantCount:safeCount(value.enabledSandboxTenantCount),
    enabledLiveTenantCount:safeCount(value.enabledLiveTenantCount),
    tenantRollouts,
    operationalEvidenceRequests
  };
}

function sanitizeTenantRollouts(value){
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>100)return null;
  const result=[];
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item))return null;
    const tenantId=String(item.tenantId||'');
    const environment=safeEnum(item.environment,ENVIRONMENTS);
    const status=safeEnum(item.status,new Set(['disabled','enabled']));
    if(!UUID.test(tenantId)||!environment||!status)return null;
    result.push({
      tenantId,
      tenantName:safeText(item.tenantName,160),
      tenantSlug:safeText(item.tenantSlug,120),
      environment,
      status,
      pendingApproval:item.pendingApproval===true,
      requestedAt:safeDate(item.requestedAt)
    });
  }
  return result;
}

function sanitizeOperationalEvidenceRequests(value){
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>50)return null;
  const result=[];
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item))return null;
    const requestId=String(item.requestId||'');
    const checkKey=safeEnum(item.checkKey,EVIDENCE_CHECKS);
    const status=safeEnum(item.status,new Set(['pending','approved']));
    const artifactSha256=String(item.artifactSha256||'');
    const expiresAt=safeDate(item.expiresAt);
    if(!UUID.test(requestId)||!checkKey||!status
       ||!/^[a-f0-9]{64}$/.test(artifactSha256)||!expiresAt)return null;
    result.push({
      requestId,checkKey,status,artifactSha256,
      pendingApproval:item.pendingApproval===true,
      requestedAt:safeDate(item.requestedAt),expiresAt
    });
  }
  return result;
}

function sanitizeGlobalAction(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
     ||value.schemaVersion!==1||value.providerKey!=='paymob')return null;
  const status=safeEnum(value.status,PROVIDER_STATUSES);
  const rolloutMode=safeEnum(value.rolloutMode,ROLLOUT_MODES);
  if(!status||!rolloutMode||typeof value.pendingApproval!=='boolean'
     ||typeof value.active!=='boolean')return null;
  return {
    schemaVersion:1,
    providerKey:'paymob',
    status,
    rolloutMode,
    pendingApproval:value.pendingApproval,
    active:value.active
  };
}

function sanitizeTenantAction(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
     ||value.schemaVersion!==1)return null;
  const tenantId=String(value.tenantId||'');
  const environment=safeEnum(value.environment,ENVIRONMENTS);
  const status=safeEnum(value.status,new Set(['disabled','enabled']));
  if(!UUID.test(tenantId)||!environment||!status
     ||typeof value.pendingApproval!=='boolean')return null;
  return {
    schemaVersion:1,
    tenantId,
    environment,
    status,
    pendingApproval:value.pendingApproval
  };
}

function sanitizeEvidenceAction(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
     ||value.schemaVersion!==1)return null;
  const requestId=String(value.requestId||'');
  const checkKey=safeEnum(value.checkKey,EVIDENCE_CHECKS);
  const environment=safeEnum(value.environment,ENVIRONMENTS);
  const status=safeEnum(value.status,new Set(['pending','approved']));
  const expiresAt=safeDate(value.expiresAt);
  if(!UUID.test(requestId)||!checkKey||environment!=='live'||!status
     ||typeof value.pendingApproval!=='boolean'||!expiresAt)return null;
  return {
    schemaVersion:1,requestId,checkKey,environment,status,
    pendingApproval:value.pendingApproval,expiresAt
  };
}

async function readTextLimited(source,maxBytes){
  const contentLength=source.headers.get('content-length');
  if(contentLength&&/^\d+$/.test(contentLength)
     &&Number(contentLength)>maxBytes){
    await source.body?.cancel('body_too_large').catch(()=>{});
    return {tooLarge:true,text:''};
  }
  if(!source.body)return {tooLarge:false,text:''};
  const reader=source.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0;
  let text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done){
        text+=decoder.decode();
        return {tooLarge:false,text};
      }
      bytes+=value.byteLength;
      if(bytes>maxBytes){
        await reader.cancel('body_too_large').catch(()=>{});
        return {tooLarge:true,text:''};
      }
      text+=decoder.decode(value,{stream:true});
    }
  }finally{
    reader.releaseLock();
  }
}

function sameOrigin(request){
  const site=String(request.headers.get('sec-fetch-site')||'').toLowerCase();
  if(site&&site!=='same-origin')return false;
  const origin=request.headers.get('origin');
  if(!origin)return site==='same-origin';
  try{
    const source=new URL(origin);
    const target=requestOrigin(request);
    return Boolean(target)
      &&source.username===''&&source.password===''
      &&source.pathname==='/'&&!source.search&&!source.hash
      &&source.origin===target;
  }catch{return false;}
}

function requestOrigin(request){
  const target=new URL(request.url);
  const forwardedHost=String(request.headers.get('x-forwarded-host')||'').trim();
  const forwardedProto=String(request.headers.get('x-forwarded-proto')||'')
    .trim().toLowerCase();
  if(forwardedHost||forwardedProto){
    if(!forwardedHost||!forwardedProto||forwardedHost.includes(',')
       ||forwardedProto.includes(',')
       ||!['http','https'].includes(forwardedProto)
       ||!/^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::\d{1,5})?$/i.test(forwardedHost)){
      return null;
    }
    return `${forwardedProto}://${forwardedHost.toLowerCase()}`;
  }
  return ['https:','http:'].includes(target.protocol)?target.origin:null;
}

function rpcError(status,value){
  const errorCode=safeCode(value?.message||value?.error)
    ||'paymob_control_unavailable';
  return json({error:controlError(errorCode),errorCode},{
    status:[400,401,403,404,409,422,429].includes(status)?status:503
  });
}

function unavailable(error,message){
  const timedOut=error instanceof Error&&error.name==='TimeoutError';
  return json({error:timedOut?`${message}؛ انتهت مهلة الخادم`:message},{
    status:timedOut?504:503
  });
}

function controlError(code){
  const messages={
    forbidden:'ليس لديك صلاحية إدارة تشغيل Paymob',
    platform_subject_not_found:'تعذر توثيق هوية منفّذ الإجراء',
    payment_provider_not_found:'إعداد Paymob غير موجود',
    paymob_activation_target_invalid:'بيئة التفعيل غير صالحة',
    paymob_activation_confirmation_invalid:'نص تأكيد التفعيل غير مطابق',
    paymob_activation_checker_required:'يلزم مراجع مختلف خلال 24 ساعة',
    paymob_activation_evidence_incomplete:'أدلة الجاهزية لهذه البيئة غير مكتملة',
    tenant_not_found:'المنشأة غير موجودة',
    paymob_reef_skills_rollout_prohibited:'يحظر استخدام Reef Skills في Canary Paymob',
    paymob_environment_invalid:'بيئة Paymob غير صالحة',
    paymob_global_rollout_not_ready:'فعّل بوابة البيئة العامة بعد اكتمال الأدلة أولًا',
    paymob_rollout_confirmation_invalid:'نص تأكيد إتاحة المنشأة غير مطابق',
    paymob_rollout_checker_required:'يلزم مراجع مختلف خلال 24 ساعة لإتاحة المنشأة',
    paymob_operational_evidence_invalid:'نوع الدليل أو بصمة الملف غير صالحة',
    paymob_live_credential_version_required:'يلزم إصدار اعتماد Live نشط ومطابق أولًا',
    paymob_operational_evidence_confirmation_invalid:'نص تأكيد الدليل التشغيلي غير مطابق',
    paymob_operational_evidence_checker_required:'يلزم مراجع مختلف لدليل تشغيلي معلّق وساري',
    paymob_operational_evidence_already_approved:'هذا الدليل التشغيلي معتمد بالفعل'
  };
  return messages[code]||'تعذر تنفيذ إجراء حوكمة Paymob';
}

function hasExactKeys(value,allowed){
  const keys=Object.keys(value);
  return keys.length===allowed.size&&keys.every(key=>allowed.has(key));
}

function safeEnum(value,allowed){
  const result=String(value||'');
  return allowed.has(result)?result:null;
}

function safeCodes(value){
  if(!Array.isArray(value)||value.length>50)return [];
  return value.map(safeCode).filter(Boolean);
}

function safeCode(value){
  const result=String(value||'').trim();
  return /^[a-z][a-z0-9_]{0,119}$/.test(result)?result:null;
}

function safeText(value,maxLength){
  const result=String(value||'').trim();
  return result&&result.length<=maxLength
    &&!/[\u0000-\u001f\u007f<>]/.test(result)?result:null;
}

function safeDate(value){
  if(value===null||value===undefined)return null;
  const result=String(value);
  return result.length<=80&&Number.isFinite(Date.parse(result))?result:null;
}

function safeCount(value){
  const result=Number(value);
  return Number.isSafeInteger(result)&&result>=0?result:0;
}

function json(body,init={}){
  return NextResponse.json(body,{
    ...init,
    headers:{
      'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer',
      Vary:'Cookie',
      ...(init.headers||{})
    }
  });
}
