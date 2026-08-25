import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get('SUPABASE_URL')??'';
const ANON_KEY=environmentKey('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY=environmentKey('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY');
const DIRECTORY_API=Deno.env.get('ODEIR_REGISTRATION_DIRECTORY_API_URL')
  ||'https://jultamrxwrgzohoktbgr.supabase.co/functions/v1/marktone-free-trial';
const MAX_BODY_BYTES=16*1024;
const MAX_DIRECTORY_RESPONSE_BYTES=128*1024;
const OPERATION_DEADLINE_MS=24_000;

const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, max-age=0',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'x-odeir-registration-gateway-version':'1'
};

type JsonRecord=Record<string,unknown>;

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST'){
    return json({ok:false,error:'method_not_allowed'},405);
  }
  if(!SUPABASE_URL||!ANON_KEY||!SERVICE_ROLE_KEY){
    return json({ok:false,error:'registration_activation_gateway_unavailable'},503);
  }
  const authorization=request.headers.get('authorization')??'';
  if(!/^Bearer\s+[^\s]+$/i.test(authorization)){
    return json({ok:false,error:'authentication_required'},401);
  }
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY_BYTES){
    return json({ok:false,error:'request_too_large'},413);
  }
  const rawBody=await boundedRequestText(request,MAX_BODY_BYTES);
  if(rawBody===null){
    return json({ok:false,error:'request_too_large'},413);
  }
  let body:JsonRecord;
  try{
    body=JSON.parse(rawBody);
    if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();
  }catch{return json({ok:false,error:'invalid_json'},400);}

  const requestId=clean(body.requestId,48);
  const expectedVersion=Number(body.expectedVersion);
  const notes=clean(body.notes,1200)||null;
  const payload=body.payload;
  if(!isUuid(requestId)){
    return json({ok:false,error:'invalid_request_id'},400);
  }
  if(!Number.isInteger(expectedVersion)||expectedVersion<1){
    return json({ok:false,error:'registration_request_conflict'},409);
  }
  if(!payload||Array.isArray(payload)||typeof payload!=='object'){
    return json({ok:false,error:'registration_payload_invalid'},400);
  }

  const deadlineAt=Date.now()+OPERATION_DEADLINE_MS;
  try{
    const detail=await rpcUser<JsonRecord>(
      authorization,
      'v1_platform_registration_request_detail',
      {p_request_id:requestId},
      {deadlineAt,maxMs:5_000}
    );
    const requestRow=registrationRequestOf(detail);
    if(!requestRow)throw new GatewayError('registration_request_not_found',404);
    const status=clean(valueOf(requestRow,[
      'status','requestStatus','request_status'
    ]),32).toLowerCase();
    const provisionedTenantId=clean(valueOf(requestRow,[
      'provisionedTenantId','provisioned_tenant_id','tenantId','tenant_id'
    ]),64);

    // A lost response can be replayed without repeating directory verification.
    // The database function proves tenant provenance and returns the same tenant.
    if(status==='converted'&&isUuid(provisionedTenantId)){
      const replay=await activate(
        authorization,{requestId,expectedVersion,notes,payload},deadlineAt
      );
      return json({ok:true,data:replay,replayed:true});
    }

    const state=clean(valueOf(requestRow,[
      'institutionState','institution_state'
    ]),24).toLowerCase();
    if(state!=='existing'){
      throw new GatewayError('registration_institution_state_invalid',409);
    }
    const externalAccountId=clean(valueOf(requestRow,[
      'externalAccountId','external_account_id','accountId','account_id'
    ]),64).toLowerCase();
    const institutionName=clean(valueOf(requestRow,[
      'institutionName','institution_name','organizationName','organization_name'
    ]),240);
    if(!isUuid(externalAccountId)){
      throw new GatewayError('registration_external_account_required',409);
    }
    if(institutionName.length<2){
      throw new GatewayError('registration_external_institution_mismatch',409);
    }

    const prepared=await rpcUser<JsonRecord>(
      authorization,
      'v1_platform_registration_activation_attestation_prepare',
      {p_request_id:requestId,p_expected_version:expectedVersion},
      {deadlineAt,maxMs:5_000}
    );
    const attestationId=clean(prepared.attestationId,48);
    const nonce=clean(prepared.nonce,160);
    const preparedRequestId=clean(prepared.requestId,48);
    const preparedVersion=Number(prepared.requestVersion);
    const expiresAt=Date.parse(String(prepared.expiresAt||''));
    if(
      !isUuid(attestationId)
      ||!/^[a-f0-9]{64}$/.test(nonce)
      ||preparedRequestId!==requestId
      ||preparedVersion!==expectedVersion
      ||!Number.isFinite(expiresAt)
      ||expiresAt<=Date.now()
    ){
      throw new GatewayError('registration_attestation_unavailable',503);
    }

    const evidence=await verifyDirectoryInstitution({
      externalAccountId,institutionName,deadlineAt
    });
    await rpcService(
      'v1_registration_activation_attestation_complete',
      {
        p_attestation_id:attestationId,
        p_nonce:nonce,
        p_directory_evidence:evidence
      },
      {deadlineAt,maxMs:5_000}
    );
    const result=await activate(
      authorization,
      {
        requestId,expectedVersion,notes,
        payload:{...(payload as JsonRecord),attestationId}
      },
      deadlineAt
    );
    return json({ok:true,data:result});
  }catch(error){
    const normalized=normalizeError(error);
    if(normalized.status>=500){
      console.error('odeir-registration-manual-activation',normalized.code);
    }
    return json({ok:false,error:normalized.code},normalized.status);
  }
});

async function activate(
  authorization:string,
  input:{requestId:string;expectedVersion:number;notes:string|null;payload:unknown},
  deadlineAt:number
){
  return rpcUser<JsonRecord>(
    authorization,
    'v1_platform_registration_approve_and_activate',
    {
      p_request_id:input.requestId,
      p_expected_version:input.expectedVersion,
      p_notes:input.notes,
      p_payload:input.payload
    },
    {deadlineAt,maxMs:9_000}
  );
}

async function rpcUser<T>(
  authorization:string,name:string,body:JsonRecord,
  options:{deadlineAt:number;maxMs:number}
):Promise<T>{
  return rpc<T>(name,body,ANON_KEY,authorization,options);
}

async function rpcService<T=unknown>(
  name:string,body:JsonRecord,options:{deadlineAt:number;maxMs:number}
):Promise<T>{
  const authorization=looksLikeJwt(SERVICE_ROLE_KEY)
    ?`Bearer ${SERVICE_ROLE_KEY}`
    :'';
  return rpc<T>(name,body,SERVICE_ROLE_KEY,authorization,options);
}

async function rpc<T>(
  name:string,body:JsonRecord,apiKey:string,authorization:string,
  {deadlineAt,maxMs}:{deadlineAt:number;maxMs:number}
):Promise<T>{
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:apiKey,
      ...(authorization?{Authorization:authorization}:{}),
      'content-type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store',
    signal:deadlineSignal(deadlineAt,maxMs)
  });
  const raw=await boundedResponseText(response,128*1024);
  let result:unknown={};
  try{result=raw?JSON.parse(raw):{};}catch{
    throw new GatewayError('registration_activation_gateway_invalid',503);
  }
  if(!response.ok){
    const source=String(
      (result as JsonRecord)?.message
      ||(result as JsonRecord)?.error
      ||(result as JsonRecord)?.detail
      ||'registration_activation_gateway_unavailable'
    );
    throw new GatewayError(safeDatabaseCode(source),translatedStatus(source,response.status));
  }
  return result as T;
}

async function verifyDirectoryInstitution({
  externalAccountId,institutionName,deadlineAt
}:{externalAccountId:string;institutionName:string;deadlineAt:number}){
  let directoryUrl:URL;
  try{directoryUrl=new URL(DIRECTORY_API);}catch{
    throw new GatewayError('directory_verification_unavailable',503);
  }
  if(
    directoryUrl.protocol!=='https:'
    ||!directoryUrl.hostname.endsWith('.supabase.co')
    ||directoryUrl.pathname!=='/functions/v1/marktone-free-trial'
    ||directoryUrl.search||directoryUrl.hash
  ){
    throw new GatewayError('directory_verification_unavailable',503);
  }
  let response:Response;
  try{
    response=await fetch(directoryUrl,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'details',accountId:externalAccountId}),
      cache:'no-store',
      credentials:'omit',
      redirect:'error',
      referrerPolicy:'no-referrer',
      signal:deadlineSignal(deadlineAt,6_000)
    });
  }catch{throw new GatewayError('directory_verification_unavailable',503);}
  const raw=await boundedResponseText(response,MAX_DIRECTORY_RESPONSE_BYTES);
  let result:JsonRecord={};
  try{result=raw?JSON.parse(raw):{};}catch{
    throw new GatewayError('directory_verification_unavailable',503);
  }
  if(!response.ok){
    throw new GatewayError('directory_verification_unavailable',503);
  }
  const institution=result.institution;
  if(result.ok!==true||!institution
     ||Array.isArray(institution)||typeof institution!=='object'){
    throw new GatewayError('directory_identity_mismatch',409);
  }
  const returnedId=clean(valueOf(institution as JsonRecord,[
    'id','accountId','account_id','externalAccountId','external_account_id'
  ]),64).toLowerCase();
  const returnedName=clean(valueOf(institution as JsonRecord,[
    'name','institutionName','institution_name','organizationName','organization_name'
  ]),240);
  if(
    returnedId!==externalAccountId
    ||!returnedName
    ||normalizeInstitutionName(returnedName)!==normalizeInstitutionName(institutionName)
  ){
    throw new GatewayError('directory_identity_mismatch',409);
  }
  return {
    sourceSystem:'marktone_directory',
    accountId:externalAccountId,
    institutionName:returnedName,
    officialIdentifiers:null
  };
}

async function boundedRequestText(request:Request,maxBytes:number){
  if(!request.body)return '';
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
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
  return decodeChunks(chunks,total);
}

async function boundedResponseText(response:Response,maxBytes:number){
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>maxBytes)throw new GatewayError('registration_activation_gateway_invalid',503);
  if(!response.body)return '';
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel();
        throw new GatewayError('registration_activation_gateway_invalid',503);
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  return decodeChunks(chunks,total);
}

function decodeChunks(chunks:Uint8Array[],total:number){
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

function registrationRequestOf(value:unknown):JsonRecord|null{
  if(!value||Array.isArray(value)||typeof value!=='object')return null;
  const source=value as JsonRecord;
  const candidate=source.request||source.item||source.registrationRequest
    ||source.registration_request||source;
  return candidate&&typeof candidate==='object'&&!Array.isArray(candidate)
    ?candidate as JsonRecord
    :null;
}

function valueOf(source:JsonRecord,keys:string[],fallback:unknown=''){
  for(const key of keys){
    const value=source?.[key];
    if(value!==undefined&&value!==null&&value!=='')return value;
  }
  return fallback;
}

function normalizeInstitutionName(value:unknown){
  return clean(value,240).toLocaleLowerCase('ar').replace(/\s+/g,' ').trim();
}

function clean(value:unknown,max:number){
  return String(value??'').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);
}

function safeDatabaseCode(source:string){
  const match=source.match(/(?:registration|directory)_[a-z0-9_]+|forbidden|authentication_required/);
  return match?.[0]||'registration_activation_gateway_unavailable';
}

function translatedStatus(source:string,fallback:number){
  if(source.includes('forbidden'))return 403;
  if(source.includes('not_found'))return 404;
  if(source.includes('conflict')||source.includes('_mismatch')
     ||source.includes('_claimed')||source.includes('already_provisioned'))return 409;
  if(fallback===401)return 401;
  if(source.includes('_invalid')||source.includes('_required'))return 400;
  return 503;
}

function deadlineSignal(deadlineAt:number,maxMs:number){
  const remaining=Math.floor(deadlineAt-Date.now());
  if(!Number.isFinite(remaining)||remaining<250){
    throw new GatewayError('registration_operation_deadline_exceeded',503);
  }
  return AbortSignal.timeout(Math.max(250,Math.min(maxMs,remaining)));
}

function normalizeError(error:unknown){
  if(error instanceof GatewayError)return error;
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)){
    return new GatewayError('registration_operation_timeout',503);
  }
  return new GatewayError('registration_activation_gateway_unavailable',503);
}

function environmentKey(keySetName:string,legacyName:string){
  const keySet=Deno.env.get(keySetName);
  if(keySet){
    try{
      const parsed=JSON.parse(keySet) as Record<string,unknown>;
      const preferred=parsed.default;
      if(typeof preferred==='string'&&preferred.trim())return preferred.trim();
    }catch{
      // A malformed key set must not hide a still-valid legacy fallback.
    }
  }
  return (Deno.env.get(legacyName)??'').trim();
}

function looksLikeJwt(value:string){
  return value.split('.').length===3;
}

function isUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function json(value:JsonRecord,status=200){
  return new Response(JSON.stringify(value),{status,headers:JSON_HEADERS});
}

class GatewayError extends Error{
  code:string;
  status:number;
  constructor(code:string,status:number){
    super(code);
    this.code=code;
    this.status=status;
  }
}
