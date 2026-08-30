import 'server-only';

import {SUPABASE_URL} from './config';
import {
  canonicalManagerMemoryProposal,
  containsManagerPersonFact
} from './odeiry-manager-memory-safety.mjs';

const SERVICE_TIMEOUT_MS=10*1000;
const SERVICE_BODY_LIMIT=80*1024;
const V4_FINALIZER_URL=
  `${SUPABASE_URL}/rest/v1/rpc/v4_service_odeiry_finalize`;
const LEGACY_FINALIZER_URL=
  `${SUPABASE_URL}/rest/v1/rpc/v3_tenant_odeiry_finalize`;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINAL_STATUSES=new Set(['completed','failed','cancelled']);

export class OdeiryServiceRpcError extends Error{
  constructor(code,status=502){
    super(code);
    this.name='OdeiryServiceRpcError';
    this.code=code;
    this.status=status;
  }
}

export function hasOdeiryServiceCredential(){
  return serviceCredentialValue().length>=20;
}

export async function finalizeOdeiryRun({
  slug,runId,status,payload,managerMemoryProposals=null
}){
  const secret=serviceCredential();
  const normalizedSlug=String(slug||'').trim().toLowerCase();
  const normalizedRunId=String(runId||'').trim().toLowerCase();
  const normalizedStatus=String(status||'').trim().toLowerCase();
  if(!SLUG.test(normalizedSlug)||normalizedSlug.length>100
     ||!UUID.test(normalizedRunId)||!FINAL_STATUSES.has(normalizedStatus)
     ||!isPlainObject(payload)){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }

  let normalizedProposals=null;
  if(managerMemoryProposals!==null){
    if(normalizedStatus!=='completed'||!Array.isArray(managerMemoryProposals)
       ||managerMemoryProposals.length>2){
      throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
    }
    normalizedProposals=managerMemoryProposals.map(normalizeMemoryProposal);
  }

  const body=JSON.stringify({
    p_slug:normalizedSlug,
    p_run_id:normalizedRunId,
    p_status:normalizedStatus,
    p_payload:payload,
    p_manager_memory_proposals:normalizedProposals
  });
  if(new TextEncoder().encode(body).byteLength>SERVICE_BODY_LIMIT){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }

  const headers={
    apikey:secret,
    'Content-Type':'application/json'
  };
  // Modern sb_secret keys authenticate through `apikey` only. Legacy
  // service_role JWTs also need the bearer header for PostgREST.
  if(isLegacyJwt(secret))headers.Authorization=`Bearer ${secret}`;

  let {response,data}=await postFinalizer(
    V4_FINALIZER_URL,headers,body
  );
  if(response.ok)return data;

  // Safe rollout bridge: an application deployment may briefly precede the
  // migration that installs v4. Only a precise PostgREST function-cache miss
  // may use the legacy finalizer, and never when manager memory proposals are
  // present. All other errors remain closed and are surfaced normally.
  if(normalizedProposals===null&&isMissingV4Finalizer(response,data)){
    const legacyBody=JSON.stringify({
      p_slug:normalizedSlug,
      p_run_id:normalizedRunId,
      p_status:normalizedStatus,
      p_payload:payload
    });
    ({response,data}=await postFinalizer(
      LEGACY_FINALIZER_URL,headers,legacyBody
    ));
    if(response.ok)return data;
  }

  const code=serviceDatabaseCode(data,response.status);
  console.error('[odeiry-service-rpc-failure]',{
    status:response.status,
    code
  });
  throw new OdeiryServiceRpcError(code,serviceStatus(code,response.status));
}

async function postFinalizer(url,headers,body){
  let response;
  try{
    response=await fetch(url,{
        method:'POST',
        headers,
        body,
        cache:'no-store',
        signal:AbortSignal.timeout(SERVICE_TIMEOUT_MS)
      });
  }catch(error){
    const timedOut=error instanceof Error
      &&['AbortError','TimeoutError'].includes(error.name);
    console.error('[odeiry-service-rpc-network-failure]',{
      errorName:error instanceof Error?error.name:'UnknownError',
      timedOut
    });
    throw new OdeiryServiceRpcError(
      timedOut?'odeiry_persistence_timeout':'odeiry_persistence_unavailable',
      timedOut?504:502
    );
  }
  return {response,data:await readResponseJson(response)};
}

function isMissingV4Finalizer(response,data){
  return response.status===404
    &&data?.code==='PGRST202'
    &&String(data?.message||'').includes('v4_service_odeiry_finalize');
}

function serviceCredential(){
  const value=serviceCredentialValue();
  if(value.length<20){
    throw new OdeiryServiceRpcError(
      'odeiry_service_configuration_invalid',
      503
    );
  }
  return value;
}

function serviceCredentialValue(){
  // Prefer Supabase's current secret-key name while remaining compatible with
  // deployments that already use the conventional legacy service-role name.
  return [
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  ].map(value=>String(value||'').trim())
    .find(value=>value.length>=20)||'';
}

function isLegacyJwt(value){
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

async function readResponseJson(response){
  const raw=await response.text();
  if(!raw)return null;
  try{return JSON.parse(raw);}catch{return null;}
}

function serviceDatabaseCode(data,status){
  if(status===401||status===403){
    return 'odeiry_service_configuration_invalid';
  }
  const source=String(data?.message||data?.hint||data?.details||'').trim();
  if(source.includes('odeiry_manager_mode_invariant_failed')
     ||source.includes('odeiry_manager_source_message_missing')){
    return 'odeiry_manager_internal_contract_invalid';
  }
  if(source.includes('odeiry_manager_idempotency_conflict')){
    return 'odeiry_finalization_conflict';
  }
  const known=[
    'odeiry_run_not_found','odeiry_finalization_conflict',
    'odeiry_run_state_invalid','odeiry_final_status_invalid',
    'odeiry_response_invalid','odeiry_response_data_invalid',
    'odeiry_usage_invalid','odeiry_model_invalid','odeiry_finish_reason_invalid',
    'odeiry_citations_invalid','odeiry_error_code_invalid',
    'odeiry_metadata_invalid','odeiry_thread_not_found',
    'odeiry_payload_invalid','tenant_not_found',
    'odeiry_manager_unavailable','odeiry_manager_run_not_found',
    'odeiry_manager_payload_invalid','odeiry_manager_cross_mode_forbidden',
    'odeiry_manager_internal_contract_invalid'
  ];
  return known.find(item=>source===item||source.includes(item))
    ||(status>=500?'odeiry_persistence_unavailable':'odeiry_persistence_rejected');
}

function serviceStatus(code,fallback){
  if(code==='odeiry_service_configuration_invalid')return 503;
  if(code==='odeiry_persistence_timeout')return 504;
  if(code==='odeiry_finalization_conflict')return 409;
  if(code==='odeiry_manager_cross_mode_forbidden')return 409;
  if(code==='odeiry_manager_unavailable')return 503;
  if(code==='odeiry_manager_internal_contract_invalid')return 502;
  return fallback>=500?502:500;
}

function isPlainObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function normalizeMemoryProposal(value){
  if(!isPlainObject(value)){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }
  const allowed=new Set([
    'memoryKey','category','statement','evidenceBasis','evidenceQuote',
    'validForDays'
  ]);
  if(Object.keys(value).some(key=>!allowed.has(key))){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }
  const memoryKey=boundedText(value.memoryKey,80).toLowerCase();
  const category=boundedText(value.category,40);
  const statement=boundedText(value.statement,240);
  const evidenceQuote=boundedText(value.evidenceQuote,160);
  const validForDays=value.validForDays===null
    ?null:Number(value.validForDays);
  const canonical=canonicalManagerMemoryProposal({
    memoryKey,category,statement,evidenceQuote
  });
  if(!canonical||statement.length<4||evidenceQuote.length<4
     ||value.evidenceBasis!=='current_user_explicit'
     ||unsafeMemoryText(statement)||unsafeMemoryText(evidenceQuote)
     ||![null,30,90,180,365].includes(validForDays)){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }
  return {
    memoryKey:canonical.memoryKey,
    category:canonical.category,
    statement:canonical.statement,
    evidenceBasis:'current_user_explicit',
    evidenceQuote,
    validForDays
  };
}

function boundedText(value,maxCharacters){
  if(typeof value!=='string')return '';
  const normalized=value.trim();
  if(!normalized||[...normalized].length>maxCharacters)return '';
  return normalized;
}

function unsafeMemoryText(value){
  const text=String(value||'');
  const digits=text.replace(/[٠-٩۰-۹]/g,digit=>{
    const arabic='٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
    return String(arabic>=0?arabic:'۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
  });
  const digitCount=(digits.match(/[0-9]/g)||[]).length;
  return /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(text)
    ||/[\w.+-]+\s*@\s*[\w.-]+\.[a-z]{2,}/iu.test(text)
    ||digitCount>=8
    ||/\b(?:sk|rk|pk)-[a-z0-9_-]{8,}\b/iu.test(text)
    ||/(?:password|api[ _-]?key|secret|access[ _-]?token|otp|my name|my manager is|employee is|customer is|كلمة المرور|كلمة السر|مفتاح api|رمز التحقق|الرقم القومي|اسمي|اسمه|اسمها|يدعى|تدعى)/iu.test(text)
    ||/(?:(?:our|the|my)\s+(?:[a-z]+\s+){0,3}(?:manager|employee|customer|client)\s+(?:is|named)|we have.{0,40}(?:manager|employee|customer|client)|(?:عندنا|لدينا).{0,40}(?:مدير|موظف|موظفة|عميل|عميلة)|(?:مدير|موظف|موظفة|عميل|عميلة|زميلي|زميلتي).{0,40}(?:عندنا|لدينا|اسمه|اسمها|يدعى|تدعى))/iu.test(text)
    ||containsManagerPersonFact(text)
    ||/(?:ignore (?:all |the )?(?:previous|system|developer)|system prompt|developer message|bypass|jailbreak|تجاهل (?:كل )?(?:التعليمات|القواعد)|تعليمات النظام|أوامر النظام|اكشف الأسرار|تجاوز الحماية)/iu.test(text);
}
