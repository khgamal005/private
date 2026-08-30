import 'server-only';

import {SUPABASE_URL} from './config';

const SERVICE_TIMEOUT_MS=10*1000;
const SERVICE_BODY_LIMIT=64*1024;
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

export async function finalizeOdeiryRun({slug,runId,status,payload}){
  const secret=serviceCredential();
  const normalizedSlug=String(slug||'').trim().toLowerCase();
  const normalizedRunId=String(runId||'').trim().toLowerCase();
  const normalizedStatus=String(status||'').trim().toLowerCase();
  if(!SLUG.test(normalizedSlug)||normalizedSlug.length>100
     ||!UUID.test(normalizedRunId)||!FINAL_STATUSES.has(normalizedStatus)
     ||!isPlainObject(payload)){
    throw new OdeiryServiceRpcError('odeiry_service_payload_invalid',500);
  }

  const body=JSON.stringify({
    p_slug:normalizedSlug,
    p_run_id:normalizedRunId,
    p_status:normalizedStatus,
    p_payload:payload
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

  let response;
  try{
    response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v3_tenant_odeiry_finalize`,
      {
        method:'POST',
        headers,
        body,
        cache:'no-store',
        signal:AbortSignal.timeout(SERVICE_TIMEOUT_MS)
      }
    );
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

  const data=await readResponseJson(response);
  if(response.ok)return data;
  const code=serviceDatabaseCode(data,response.status);
  console.error('[odeiry-service-rpc-failure]',{
    status:response.status,
    code
  });
  throw new OdeiryServiceRpcError(code,serviceStatus(code,response.status));
}

function serviceCredential(){
  const value=String(process.env.SUPABASE_SECRET_KEY||'').trim();
  if(value.length<20){
    throw new OdeiryServiceRpcError(
      'odeiry_service_configuration_invalid',
      503
    );
  }
  return value;
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
  const known=[
    'odeiry_run_not_found','odeiry_finalization_conflict',
    'odeiry_run_state_invalid','odeiry_final_status_invalid',
    'odeiry_response_invalid','odeiry_response_data_invalid',
    'odeiry_usage_invalid','odeiry_model_invalid','odeiry_finish_reason_invalid',
    'odeiry_citations_invalid','odeiry_error_code_invalid',
    'odeiry_metadata_invalid','odeiry_thread_not_found',
    'odeiry_payload_invalid','tenant_not_found'
  ];
  return known.find(item=>source===item||source.includes(item))
    ||(status>=500?'odeiry_persistence_unavailable':'odeiry_persistence_rejected');
}

function serviceStatus(code,fallback){
  if(code==='odeiry_service_configuration_invalid')return 503;
  if(code==='odeiry_persistence_timeout')return 504;
  if(code==='odeiry_finalization_conflict')return 409;
  return fallback>=500?502:500;
}

function isPlainObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}
