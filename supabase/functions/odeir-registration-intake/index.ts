import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get('SUPABASE_URL')??'';
const SERVICE_ROLE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
const INTAKE_TOKEN=Deno.env.get('ODEIR_REGISTRATION_INGRESS_TOKEN')??'';
const RATE_SALT=Deno.env.get('ODEIR_REGISTRATION_RATE_SALT')
  ||INTAKE_TOKEN
  ||SERVICE_ROLE_KEY;
// Platform-registration email credentials are deliberately isolated from
// every tenant-owned messaging provider and legacy training fallback.
const REGISTRATION_RESEND_API_KEY=
  Deno.env.get('ODEIR_REGISTRATION_RESEND_API_KEY')?.trim()??'';
const REGISTRATION_FROM_EMAIL=
  Deno.env.get('ODEIR_REGISTRATION_FROM_EMAIL')?.trim()??'';
const REGISTRATION_DOMAIN_VERIFIED_NAME=
  Deno.env.get('ODEIR_REGISTRATION_DOMAIN_VERIFIED_NAME')?.trim()
    .toLowerCase()??'';
const REGISTRATION_DOMAIN_VERIFIED_AT=
  Deno.env.get('ODEIR_REGISTRATION_DOMAIN_VERIFIED_AT')?.trim()??'';
const REGISTRATION_RESEND_WEBHOOK_SECRET=
  Deno.env.get('ODEIR_REGISTRATION_RESEND_WEBHOOK_SECRET')?.trim()??'';
const CONFIRMATION_KEY_VERSION=Math.max(
  1,
  Number.parseInt(
    Deno.env.get('ODEIR_REGISTRATION_CONFIRMATION_KEY_VERSION')??'1',
    10
  )||1
);
const PUBLIC_APP_URL=Deno.env.get('ODEIR_PUBLIC_APP_URL')
  ||'https://odeir.com';
const PRODUCTION_PROJECT_REF='gswpbwdactcstkasddta';
const IS_PRODUCTION_PROJECT=(()=>{
  try{
    return new URL(SUPABASE_URL).hostname===
      `${PRODUCTION_PROJECT_REF}.supabase.co`;
  }catch{return false;}
})();
const CHALLENGE_AUDIENCE='registration-submit';
const CHALLENGE_TTL_SECONDS=300;
const DOMAIN_VERIFICATION_MAX_AGE_MS=30*24*60*60*1000;
const DOMAIN_VERIFICATION_FUTURE_SKEW_MS=5*60*1000;
const ALLOWED_CHALLENGE_ORIGINS=new Set(IS_PRODUCTION_PROJECT
  ?['https://odeir.com','https://www.odeir.com']
  :[
    'https://odeir.com','https://www.odeir.com','https://staging.odeir.com',
    'http://localhost:3000','http://127.0.0.1:3000'
  ]
);

const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, max-age=0',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'
};

type JsonRecord=Record<string,unknown>;
type ChallengeClaims={
  v:1;
  aud:string;
  jti:string;
  iat:number;
  exp:number;
  ipHash:string;
  userAgentHash:string|null;
};

let challengeSigningKey:Promise<CryptoKey>|null=null;
const confirmationSigningKeys=new Map<number,Promise<CryptoKey>>();

Deno.serve(async(request:Request)=>{
  const corsOrigin=allowedChallengeOrigin(request);
  if(request.method==='OPTIONS'){
    if(!corsOrigin)return json({ok:false,error:'origin_not_allowed'},403);
    return new Response(null,{status:204,headers:corsHeaders(corsOrigin)});
  }
  if(request.method!=='POST'){
    return json({ok:false,error:'method_not_allowed'},405,corsOrigin);
  }
  if(!SUPABASE_URL||!SERVICE_ROLE_KEY||RATE_SALT.length<32){
    return json({ok:false,error:'service_unavailable'},503,corsOrigin);
  }
  if(Number(request.headers.get('content-length')??'0')>16_384){
    return json({ok:false,error:'request_too_large'},413,corsOrigin);
  }

  const rawBody=await boundedRequestText(request,16_384);
  if(rawBody===null){
    return json({ok:false,error:'request_too_large'},413,corsOrigin);
  }

  // Resend signs the exact raw bytes.  Detect webhook traffic before parsing or
  // transforming JSON and never log its payload (it contains recipient PII).
  if(request.headers.has('svix-signature')){
    return handleResendWebhook(rawBody,request);
  }

  let body:JsonRecord;
  try{
    body=JSON.parse(rawBody);
    if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();
  }catch{return json({ok:false,error:'invalid_json'},400,corsOrigin);}

  const action=clean(body.action,24);
  if(action==='challenge'){
    if(!corsOrigin){
      return json({ok:false,error:'origin_not_allowed'},403);
    }
    return issueRegistrationChallenge(request,corsOrigin);
  }
  if(action==='health'){
    if(
      !await authorizedWorkerRequest(request)
      &&!await authorizedServerRequest(request)
    ){
      return json({ok:false,error:'unauthorized'},401);
    }
    const health=await registrationEmailHealth();
    return json({ok:true,...publicRegistrationEmailHealth(health)});
  }
  if(action==='activation_grant'){
    if(!await authorizedServerRequest(request)){
      return json({ok:false,error:'unauthorized'},401);
    }
    return issueRegistrationEmailActivationGrant();
  }
  if(action==='canary'){
    if(!await authorizedServerRequest(request)){
      return json({ok:false,error:'unauthorized'},401);
    }
    return sendRegistrationEmailCanary(body);
  }
  if(action==='drain'){
    if(
      !await authorizedWorkerRequest(request)
      &&!await authorizedServerRequest(request)
    ){
      return json({ok:false,error:'unauthorized'},401);
    }
    const limit=Math.max(1,Math.min(20,Number(body.limit)||10));
    return json({ok:true,...await drainConfirmationOutbox(limit)});
  }
  if(action==='confirm'){
    if(!await authorizedServerRequest(request)){
      return json({ok:false,error:'unauthorized'},401);
    }
    return confirmRegistration(body,request);
  }
  if(action!=='submit'){
    return json({ok:false,error:'invalid_action'},400);
  }
  if(clean(body.website,120))return json({ok:true,ignored:true});
  const startedAt=Number(body.startedAt??0);
  const elapsed=Date.now()-startedAt;
  if(!startedAt||elapsed<700||elapsed>7_200_000){
    return json({ok:false,error:'invalid_session'},400);
  }

  try{
    const payload=validatedPayload(body);
    const challenge=clean(body.challenge,1024);
    if(!challenge){
      return json({ok:false,error:'registration_challenge_invalid'},400);
    }
    const claims=await consumeRegistrationChallenge(challenge);
    const ipHash=claims.ipHash;
    const userAgentHash=claims.userAgentHash;
    const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`submit:${ipHash}`,
      p_limit:3,
      p_window_seconds:86_400
    });
    if(!allowed)return json({ok:false,error:'rate_limited'},429);
    const emailRateKey=await sha256(
      `${String(payload.contactEmail).toLowerCase()}|${RATE_SALT}`
    );
    const emailAllowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`registration-email:${emailRateKey}`,
      p_limit:6,
      p_window_seconds:86_400
    });
    if(!emailAllowed)return json({ok:false,error:'rate_limited'},429);

    let result:JsonRecord;
    if(payload.institutionState==='new'&&!payload.accountId){
      // Only a genuinely new, unlinked institution can enter automatic email
      // activation.  Guarding and inserting happen in one DB transaction.
      const runtimeHealth=await registrationEmailHealth(false);
      let liveReady=runtimeHealth.activationReady===true;
      let completed:JsonRecord|null=null;
      for(let attempt=0;attempt<3;attempt++){
        const guarded=await rpc<JsonRecord>(
          'v3_public_submit_registration_request',{
          p_payload:payload,
          p_ip_hash:ipHash,
          p_user_agent_hash:userAgentHash,
          p_configuration_fingerprint:runtimeHealth.configurationFingerprint,
          p_email_activation_ready:liveReady
        });
        if(guarded._retryManual!==true){
          completed=guarded;
          break;
        }
        // The short transaction committed the emergency kill switch without
        // request locks. Re-enter the guarded RPC (never bare v2): its shared
        // lock keeps a concurrent admin re-enable from crossing this submit.
        liveReady=false;
      }
      if(!completed)throw new PublicError('service_unavailable',503);
      result=completed;
    }else{
      // Existing/linked institutions remain on their isolated manual path and
      // never depend on the registration-email transport or canary gate.
      result=await rpc<JsonRecord>('v2_public_submit_registration_request',{
        p_payload:payload,
        p_ip_hash:ipHash,
        p_user_agent_hash:userAgentHash
      });
    }

    if(result.confirmationRequired===true){
      const deliveryId=clean(result.deliveryId,48);
      if(!isUuid(deliveryId)){
        throw new Error('registration_confirmation_delivery_invalid');
      }
      scheduleBackgroundDelivery(deliveryId);
      result.confirmationQueued=true;
      result.confirmationAlreadySent=result.confirmationAlreadySent===true;
    }
    const publicResult={...result};
    delete publicResult._confirmationToken;
    delete publicResult.contactEmail;
    delete publicResult.requestId;
    delete publicResult.deliveryId;
    return json(
      {ok:true,...publicResult},
      result.confirmationRequired===true?202:(result.duplicate===true?200:201)
    );
  }catch(error){
    if(error instanceof PublicError){
      if(error.status>=500){
        console.error('odeir-registration-intake',error.code);
      }
      return json({ok:false,error:error.code},error.status);
    }
    const code=databaseErrorCode(error);
    const publicCode=PUBLIC_DATABASE_ERRORS.has(code)?code:'service_unavailable';
    console.error('odeir-registration-intake',publicCode);
    const status=[
      'service_unavailable','confirmation_email_in_progress'
    ].includes(publicCode)?503:400;
    return json({ok:false,error:publicCode},status);
  }
});

async function issueRegistrationChallenge(request:Request,corsOrigin:string){
  const clientIp=sourceClientIp(request);
  if(!clientIp){
    return json({ok:false,error:'registration_challenge_unavailable'},503,corsOrigin);
  }
  try{
    const userAgent=clean(request.headers.get('user-agent'),300);
    const [ipHash,userAgentHash]=await Promise.all([
      sha256(`${clientIp}|${RATE_SALT}`),
      userAgent?sha256(`${userAgent}|${RATE_SALT}`):Promise.resolve(null)
    ]);
    const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`challenge-issue:${ipHash}`,
      p_limit:5,
      p_window_seconds:3_600
    });
    if(!allowed)return json({ok:false,error:'rate_limited'},429,corsOrigin);

    const now=Math.floor(Date.now()/1000);
    const claims:ChallengeClaims={
      v:1,
      aud:CHALLENGE_AUDIENCE,
      jti:randomHex(32),
      iat:now,
      exp:now+CHALLENGE_TTL_SECONDS,
      ipHash,
      userAgentHash
    };
    return json({
      ok:true,
      challenge:await signChallenge(claims),
      expiresIn:CHALLENGE_TTL_SECONDS
    },200,corsOrigin);
  }catch{
    console.error('odeir-registration-challenge','service_unavailable');
    return json({ok:false,error:'registration_challenge_unavailable'},503,corsOrigin);
  }
}

async function consumeRegistrationChallenge(token:string){
  const claims=await verifyChallenge(token);
  const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
    p_rate_key:`challenge:${await sha256(claims.jti)}`,
    p_limit:1,
    p_window_seconds:600
  });
  if(!allowed)throw new PublicError('registration_challenge_invalid',400);
  return claims;
}

async function signChallenge(claims:ChallengeClaims){
  const encoded=base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature=new Uint8Array(await crypto.subtle.sign(
    'HMAC',await getChallengeSigningKey(),new TextEncoder().encode(encoded)
  ));
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifyChallenge(token:string):Promise<ChallengeClaims>{
  const parts=token.split('.');
  if(
    parts.length!==2
    ||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part))
  )throw new PublicError('registration_challenge_invalid',400);
  try{
    const valid=await crypto.subtle.verify(
      'HMAC',
      await getChallengeSigningKey(),
      base64UrlDecode(parts[1]),
      new TextEncoder().encode(parts[0])
    );
    if(!valid)throw new Error();
    const claims=JSON.parse(
      new TextDecoder().decode(base64UrlDecode(parts[0]))
    ) as ChallengeClaims;
    const now=Math.floor(Date.now()/1000);
    if(
      claims?.v!==1
      ||claims.aud!==CHALLENGE_AUDIENCE
      ||!/^[a-f0-9]{64}$/.test(claims.jti)
      ||!/^[a-f0-9]{64}$/.test(claims.ipHash)
      ||!(claims.userAgentHash===null||/^[a-f0-9]{64}$/.test(claims.userAgentHash))
      ||!Number.isInteger(claims.iat)
      ||!Number.isInteger(claims.exp)
      ||claims.exp<=claims.iat
      ||claims.exp-claims.iat>CHALLENGE_TTL_SECONDS
      ||claims.iat>now+30
      ||claims.iat<now-(CHALLENGE_TTL_SECONDS+60)
      ||claims.exp<now
    )throw new Error();
    return claims;
  }catch(error){
    if(error instanceof PublicError)throw error;
    throw new PublicError('registration_challenge_invalid',400);
  }
}

function getChallengeSigningKey(){
  challengeSigningKey??=crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(RATE_SALT),
    {name:'HMAC',hash:'SHA-256'},
    false,
    ['sign','verify']
  );
  return challengeSigningKey;
}

function randomHex(byteLength:number){
  const bytes=crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function base64UrlEncode(bytes:Uint8Array){
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function base64UrlDecode(value:string){
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const binary=atob(padded);
  return Uint8Array.from(binary,character=>character.charCodeAt(0));
}

function sourceClientIp(request:Request){
  const candidates=[
    clean(request.headers.get('cf-connecting-ip'),80),
    clean(request.headers.get('x-forwarded-for'),240)
      .split(',')[0]?.trim()??''
  ];
  return candidates.find(candidate=>
    candidate.length<=64&&(
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)
        ?candidate.split('.').every(part=>Number(part)<=255)
        :candidate.includes(':')&&/^[0-9a-f:.]+$/i.test(candidate)
    )
  )??'';
}

function allowedChallengeOrigin(request:Request){
  const origin=clean(request.headers.get('origin'),240);
  return ALLOWED_CHALLENGE_ORIGINS.has(origin)?origin:'';
}

function corsHeaders(origin:string){
  return {
    ...JSON_HEADERS,
    'access-control-allow-origin':origin,
    'access-control-allow-methods':'POST, OPTIONS',
    'access-control-allow-headers':'apikey, content-type',
    'access-control-max-age':'600',
    'vary':'Origin'
  };
}

async function authorizedServerRequest(request:Request){
  const ingress=clean(request.headers.get('x-odeir-intake-token'),256);
  if(
    INTAKE_TOKEN.length>=32
    &&ingress
    &&await secureEqual(ingress,INTAKE_TOKEN)
  )return true;

  const apiKey=clean(request.headers.get('apikey'),512);
  if(apiKey.length<32)return false;
  const response=await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/v1_registration_edge_authorize`,
    {
      method:'POST',
      headers:{
        apikey:apiKey,
        ...(looksLikeJwt(apiKey)?{authorization:`Bearer ${apiKey}`}:{}),
        'content-type':'application/json'
      },
      body:'{}',
      signal:AbortSignal.timeout(5_000)
    }
  ).catch(()=>null);
  if(!response?.ok)return false;
  return await response.json().catch(()=>false)===true;
}

async function authorizedWorkerRequest(request:Request){
  const token=clean(request.headers.get('x-odeir-worker-token'),256);
  if(token.length<32)return false;
  try{
    return await rpc<boolean>('v1_registration_email_worker_authorize',{
      p_token_hash:await sha256(token)
    })===true;
  }catch{return false;}
}

function looksLikeJwt(value:string){
  return value.split('.').length===3;
}

async function confirmRegistration(body:JsonRecord,request:Request){
  const token=clean(body.token,80).toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return json({ok:false,error:'registration_confirmation_invalid'},400);
  }
  try{
    const trustedProxy=await authorizedServerRequest(request);
    const forwardedIp=trustedProxy
      ?validClientIp(clean(request.headers.get('x-odeir-client-ip'),80))
      :'';
    const clientIp=forwardedIp||sourceClientIp(request);
    if(!clientIp){
      return json({ok:false,error:'registration_confirmation_unavailable'},503);
    }
    const ipHash=await sha256(`${clientIp}|${RATE_SALT}`);
    const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`confirm-source:${ipHash}`,
      p_limit:240,
      p_window_seconds:3_600
    });
    if(!allowed)return json({ok:false,error:'rate_limited'},429);
    const result=await rpc<JsonRecord>(
      'v1_registration_confirm_email_and_provision',
      {p_token:token}
    );
    return json({ok:true,...result});
  }catch(error){
    const code=databaseErrorCode(error);
    const publicCode=code==='service_unavailable'
      ?'registration_confirmation_unavailable'
      :code;
    console.error('odeir-registration-confirm',publicCode);
    return json({ok:false,error:publicCode},
      publicCode==='registration_confirmation_unavailable'?503:400);
  }
}

function validClientIp(value:string){
  if(value.length>64)return '';
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)){
    return value.split('.').every(part=>Number(part)<=255)?value:'';
  }
  return value.includes(':')&&/^[0-9a-f:.]+$/i.test(value)?value:'';
}

function registrationEmailTransportReady(){
  if(
    !REGISTRATION_RESEND_API_KEY
    ||!isOdeirRegistrationSender(REGISTRATION_FROM_EMAIL)
  )return false;
  try{
    const url=new URL(PUBLIC_APP_URL);
    const localHost=url.hostname==='localhost'||url.hostname==='127.0.0.1';
    if(IS_PRODUCTION_PROJECT){
      return url.origin==='https://odeir.com'&&url.pathname==='/'
        &&!url.search&&!url.hash;
    }
    const trustedHost=
      url.hostname==='odeir.com'
      ||url.hostname==='www.odeir.com'
      ||url.hostname==='staging.odeir.com'
      ||localHost;
    return trustedHost&&(
      url.protocol==='https:'||(localHost&&url.protocol==='http:')
    );
  }catch{
    return false;
  }
}

function isOdeirRegistrationSender(value:string){
  const bracketed=value.match(/<([^<>]+)>$/)?.[1]?.trim();
  const address=bracketed||value.trim();
  return /^[^\s@<>]+@odeir\.com$/i.test(address);
}

function registrationSenderDomain(value:string){
  const bracketed=value.match(/<([^<>]+)>$/)?.[1]?.trim();
  const address=(bracketed||value.trim()).toLowerCase();
  const separator=address.lastIndexOf('@');
  return separator>0?address.slice(separator+1):'';
}

function registrationDomainAttestation(now=Date.now()){
  const senderDomain=registrationSenderDomain(REGISTRATION_FROM_EMAIL);
  const verifiedAtEpoch=strictUtcTimestamp(REGISTRATION_DOMAIN_VERIFIED_AT);
  const timestampReady=verifiedAtEpoch!==null
    &&verifiedAtEpoch<=now+DOMAIN_VERIFICATION_FUTURE_SKEW_MS
    &&verifiedAtEpoch>=now-DOMAIN_VERIFICATION_MAX_AGE_MS;
  const ready=senderDomain==='odeir.com'
    &&REGISTRATION_DOMAIN_VERIFIED_NAME===senderDomain
    &&timestampReady;
  return {
    ready,
    senderDomain:senderDomain||null,
    verifiedDomain:REGISTRATION_DOMAIN_VERIFIED_NAME||null,
    verifiedAt:verifiedAtEpoch===null
      ?null:new Date(verifiedAtEpoch).toISOString(),
    expiresAt:verifiedAtEpoch===null
      ?null:new Date(
        verifiedAtEpoch+DOMAIN_VERIFICATION_MAX_AGE_MS
      ).toISOString()
  };
}

function strictUtcTimestamp(value:string){
  const match=value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/
  );
  if(!match)return null;
  const normalized=`${match[1]}.${(match[2]??'').padEnd(3,'0')}Z`;
  const parsed=Date.parse(normalized);
  return Number.isFinite(parsed)&&new Date(parsed).toISOString()===normalized
    ?parsed
    :null;
}

async function registrationEmailHealth(includeMetrics=true){
  const transportConfigured=registrationEmailTransportReady();
  const domainAttestation=registrationDomainAttestation();
  const webhookSecretConfigured=/^whsec_[A-Za-z0-9+/=_-]{20,}$/.test(
    REGISTRATION_RESEND_WEBHOOK_SECRET
  );
  let outboxReady=false;
  let outbox:JsonRecord={};
  try{
    outbox=await rpc<JsonRecord>(includeMetrics
      ?'v1_registration_email_delivery_health'
      :'v1_registration_email_runtime_readiness',{});
    outboxReady=outbox.outboxReady===true;
  }catch{
    // During the expand phase the old Edge can be deployed before the outbox.
  }
  const activeKeyVersion=positiveInteger(outbox.activeKeyVersion);
  const pendingKeyVersions=(Array.isArray(outbox.pendingKeyVersions)
    ?outbox.pendingKeyVersions:[])
    .map(positiveInteger)
    .filter((value):value is number=>value!==null);
  const requiredKeyVersions=[...new Set([
    ...(activeKeyVersion===null?[]:[activeKeyVersion]),
    ...pendingKeyVersions
  ])].sort((left,right)=>left-right);
  const missingKeyVersions=requiredKeyVersions.filter(
    version=>!confirmationSecret(version)
  );
  const configurationFingerprint=await registrationEmailConfigurationFingerprint();
  const keyConfigurationReady=
    activeKeyVersion!==null
    &&activeKeyVersion===CONFIRMATION_KEY_VERSION
    &&missingKeyVersions.length===0;
  const workerHealthy=outbox.workerHealthy===true;
  const legacyUnrecoverable=nonNegativeInteger(outbox.legacyUnrecoverable);
  const sendReady=Boolean(
    transportConfigured
    &&domainAttestation.ready
    &&keyConfigurationReady
    &&outboxReady
    &&workerHealthy
    &&legacyUnrecoverable===0
  );
  const telemetryReady=webhookSecretConfigured;
  let canary:JsonRecord={};
  if(sendReady&&telemetryReady){
    try{
      canary=await rpc<JsonRecord>('v1_registration_email_canary_health',{
        p_configuration_fingerprint:configurationFingerprint
      });
    }catch{
      // The activation gate remains closed during a migration/Edge rolling deploy.
    }
  }
  const canaryReady=canary.canaryReady===true;
  const activationReady=sendReady&&telemetryReady&&canaryReady;
  return {
    // The compatibility alias is deliberately fail-closed: a sender that can
    // hand off mail but cannot prove a recent signed delivery is not ready for
    // automatic registration activation.
    emailReady:activationReady,
    activationReady,
    configurationFingerprint,
    sendReady,
    telemetryReady,
    telemetryDegraded:sendReady&&!telemetryReady,
    canaryReady,
    canaryState:canary.canaryState??'not_run',
    canaryDeliveredAt:canary.canaryDeliveredAt??null,
    canaryExpiresAt:canary.canaryExpiresAt??null,
    emailConfigured:transportConfigured,
    webhookSecretConfigured,
    domainAttestationReady:domainAttestation.ready,
    senderDomain:domainAttestation.senderDomain,
    verifiedDomain:domainAttestation.verifiedDomain,
    domainVerifiedAt:domainAttestation.verifiedAt,
    domainVerificationExpiresAt:domainAttestation.expiresAt,
    outboxReady,
    workerHealthy,
    legacyUnrecoverable,
    workerHeartbeatAt:outbox.workerHeartbeatAt??null,
    activeKeyVersion,
    configuredKeyVersion:CONFIRMATION_KEY_VERSION,
    requiredKeyVersions,
    missingKeyVersions,
    queue:{
      queued:nonNegativeInteger(outbox.queued),
      retryable:nonNegativeInteger(outbox.retryable),
      leasedStale:nonNegativeInteger(outbox.leasedStale),
      legacyUnrecoverable,
      terminalFailed:nonNegativeInteger(outbox.terminalFailed),
      acceptedLast24h:nonNegativeInteger(outbox.acceptedLast24h),
      deliveredLast24h:nonNegativeInteger(outbox.deliveredLast24h)
    }
  };
}

function publicRegistrationEmailHealth(health:Awaited<
  ReturnType<typeof registrationEmailHealth>
>){
  const {configurationFingerprint:_configurationFingerprint,...safe}=health;
  return safe;
}

async function registrationEmailConfigurationFingerprint(){
  const canonical=[
    'odeir-registration-email-configuration-v1',
    REGISTRATION_RESEND_API_KEY,
    REGISTRATION_FROM_EMAIL,
    REGISTRATION_RESEND_WEBHOOK_SECRET,
    PUBLIC_APP_URL,
    REGISTRATION_DOMAIN_VERIFIED_NAME,
    REGISTRATION_DOMAIN_VERIFIED_AT,
    String(CONFIRMATION_KEY_VERSION),
    confirmationSecret(CONFIRMATION_KEY_VERSION)
  ].join('\u001f');
  return hmacSha256(RATE_SALT,canonical);
}

async function issueRegistrationEmailActivationGrant(){
  const health=await registrationEmailHealth(false);
  if(health.activationReady!==true){
    return json({
      ok:false,
      error:'registration_email_activation_not_ready',
      ...publicRegistrationEmailHealth(health)
    },409);
  }
  try{
    const result=await rpc<JsonRecord>(
      'v1_registration_email_activation_grant_issue',
      {p_configuration_fingerprint:health.configurationFingerprint}
    );
    const activationGrant=clean(result.activationGrant,80);
    if(!/^[a-f0-9]{64}$/.test(activationGrant))throw new Error();
    return json({
      ok:true,
      ...publicRegistrationEmailHealth(health),
      activationGrant
    });
  }catch{
    return json({
      ok:false,error:'registration_email_activation_grant_unavailable'
    },503);
  }
}

async function sendRegistrationEmailCanary(body:JsonRecord){
  const health=await registrationEmailHealth(false);
  if(health.sendReady!==true||health.telemetryReady!==true){
    return json({
      ok:false,
      error:'registration_email_canary_not_ready',
      sendReady:health.sendReady===true,
      telemetryReady:health.telemetryReady===true
    },409);
  }
  const recipient=clean(body.recipient,240).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(recipient)){
    return json({ok:false,error:'registration_email_canary_invalid'},400);
  }

  let started:JsonRecord;
  try{
    started=await rpc<JsonRecord>('v1_registration_email_canary_start',{
      p_recipient_hash:await sha256(`${recipient}|${RATE_SALT}`),
      p_configuration_fingerprint:health.configurationFingerprint
    });
  }catch(error){
    const code=databaseErrorCode(error);
    return json({
      ok:false,
      error:code==='registration_email_canary_rate_limited'
        ?code:'registration_email_canary_unavailable'
    },code==='registration_email_canary_rate_limited'?429:503);
  }
  const canaryId=clean(started.canaryId,48);
  const idempotencyKey=clean(started.idempotencyKey,200);
  if(!isUuid(canaryId)||!/^[a-z0-9/_-]{1,200}$/.test(idempotencyKey)){
    return json({ok:false,error:'registration_email_canary_unavailable'},503);
  }

  const reference=canaryId.slice(0,8).toUpperCase();
  const message={
    from:REGISTRATION_FROM_EMAIL,
    to:[recipient],
    subject:`اختبار جاهزية بريد تفعيل أودير — ${reference}`,
    html:`<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f8fb;font-family:Arial,sans-serif;color:#0b2942"><main style="max-width:620px;margin:32px auto;background:#fff;border:1px solid #d9e6ec;border-radius:18px;padding:28px"><p style="color:#0b8e88;font-weight:700">ODEIR REGISTRATION EMAIL</p><h1 style="font-size:24px">تم إرسال اختبار الإنتاج بنجاح</h1><p style="line-height:1.9">هذه رسالة Canary معزولة للتحقق من أن بريد تفعيل المنشآت يصل من نطاق أودير الموثّق وأن إشعار التسليم الموقّع يعمل.</p><p style="line-height:1.9"><strong>المرجع:</strong> ${escapeHtml(reference)}</p><p style="color:#607989;font-size:13px;line-height:1.8">لا تنشئ هذه الرسالة طلب تسجيل أو مساحة منشأة، ولا تتطلب منك أي إجراء.</p></main></body></html>`,
    text:`اختبار جاهزية بريد تفعيل أودير\n\nتم إرسال Canary الإنتاج المعزول بنجاح.\nالمرجع: ${reference}\n\nلا تنشئ هذه الرسالة طلب تسجيل أو مساحة منشأة، ولا تتطلب أي إجراء.`
  };

  let response:Response;
  try{
    response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{
        authorization:`Bearer ${REGISTRATION_RESEND_API_KEY}`,
        'content-type':'application/json',
        'Idempotency-Key':idempotencyKey
      },
      body:JSON.stringify(message),
      signal:AbortSignal.timeout(8_000)
    });
  }catch(error){
    const errorCode=error instanceof DOMException&&error.name==='TimeoutError'
      ?'resend_timeout':'resend_transport_error';
    await finishRegistrationEmailCanary({
      canaryId,outcome:'failed',providerMessageId:null,httpStatus:null,errorCode
    }).catch(()=>null);
    return json({ok:false,error:'registration_email_canary_send_failed'},503);
  }

  if(!response.ok){
    const errorCode=await resendFailureCode(response);
    await finishRegistrationEmailCanary({
      canaryId,outcome:'failed',providerMessageId:null,
      httpStatus:response.status,errorCode
    }).catch(()=>null);
    return json({
      ok:false,error:'registration_email_canary_send_failed',code:errorCode
    },response.status>=500||[408,409,425,429].includes(response.status)?503:409);
  }
  const providerMessageId=await resendMessageId(response);
  if(!providerMessageId){
    await finishRegistrationEmailCanary({
      canaryId,outcome:'failed',providerMessageId:null,
      httpStatus:response.status,errorCode:'resend_invalid_response'
    }).catch(()=>null);
    return json({ok:false,error:'registration_email_canary_send_failed'},503);
  }
  const completed=await finishRegistrationEmailCanary({
    canaryId,outcome:'accepted',providerMessageId,
    httpStatus:response.status,errorCode:null
  });
  return json({
    ok:true,
    canaryId,
    providerMessageId,
    state:completed.state??'accepted'
  },202);
}

async function finishRegistrationEmailCanary({
  canaryId,outcome,providerMessageId,httpStatus,errorCode
}:{
  canaryId:string;
  outcome:'accepted'|'failed';
  providerMessageId:string|null;
  httpStatus:number|null;
  errorCode:string|null;
}){
  return await rpc<JsonRecord>('v1_registration_email_canary_finish',{
    p_canary_id:canaryId,
    p_outcome:outcome,
    p_provider_message_id:providerMessageId,
    p_http_status:httpStatus,
    p_error_code:errorCode
  });
}

function positiveInteger(value:unknown){
  const number=Number(value);
  return Number.isInteger(number)&&number>0?number:null;
}

function nonNegativeInteger(value:unknown){
  const number=Number(value);
  return Number.isInteger(number)&&number>=0?number:0;
}

function scheduleBackgroundDelivery(deliveryId:string){
  const task=processEmailDelivery(deliveryId).catch(error=>{
    console.error('odeir-registration-email-background',safeErrorCode(error));
  });
  // Supabase keeps the isolate alive for this promise.  The durable lease and
  // periodic drain still recover if the isolate is killed at any instruction.
  EdgeRuntime.waitUntil(task);
}

async function drainConfirmationOutbox(limit:number){
  let ids:unknown;
  try{
    ids=await rpc<unknown>('v1_registration_email_delivery_due_ids',{
      p_limit:limit
    });
  }catch{
    throw new PublicError('confirmation_email_state_unavailable',503);
  }
  const deliveryIds=(Array.isArray(ids)?ids:[])
    .map(value=>typeof value==='string'?value:clean(
      value&&typeof value==='object'?(value as JsonRecord).deliveryId:'',48
    ))
    .filter(isUuid)
    .slice(0,limit);
  let cursor=0;
  let processed=0;
  let failed=0;
  const concurrency=Math.min(4,deliveryIds.length);
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(cursor<deliveryIds.length){
      const deliveryId=deliveryIds[cursor++];
      try{
        await processEmailDelivery(deliveryId);
        processed++;
      }catch{
        failed++;
      }
    }
  }));
  await rpc<JsonRecord>('v1_registration_email_delivery_worker_heartbeat',{
    p_processed:processed,
    p_failed:failed
  }).catch(()=>null);
  return {claimed:deliveryIds.length,processed,failed};
}

async function processEmailDelivery(deliveryId:string){
  const failSafe=await rpc<JsonRecord>(
    'v1_registration_email_delivery_fail_safe',
    {p_delivery_id:deliveryId}
  );
  if(failSafe.handled===true){
    return {deliveryId,state:'manual_review',sent:false};
  }
  const claim=await rpc<JsonRecord>('v1_registration_email_delivery_claim',{
    p_delivery_id:deliveryId
  });
  if(claim.accepted===true||claim.sendRequired===false){
    return {deliveryId,state:clean(claim.state,32),sent:false};
  }

  const requestId=clean(claim.requestId,48);
  const leaseId=clean(claim.leaseId,48);
  if(!isUuid(leaseId)){
    throw new Error('registration_confirmation_delivery_invalid');
  }
  if(
    !registrationEmailTransportReady()
    ||!registrationDomainAttestation().ready
  ){
    await finishEmailDelivery({
      deliveryId,leaseId,outcome:'retryable',providerMessageId:null,
      httpStatus:null,errorCode:'email_configuration_unavailable',
      retryAfterSeconds:300
    });
    throw new PublicError('email_configuration_unavailable',503);
  }
  const idempotencyKey=clean(claim.idempotencyKey,200);
  const recipient=clean(claim.recipient,240).toLowerCase();
  const generation=Number(claim.generation);
  const keyVersion=Number(claim.keyVersion);
  const tokenNonce=clean(claim.tokenNonce,80).toLowerCase();
  const tokenExpiresEpoch=Number(claim.tokenExpiresEpoch);
  const templateVersion=clean(claim.templateVersion,64);
  if(
    !isUuid(deliveryId)||!isUuid(requestId)||!isUuid(leaseId)
    ||!Number.isInteger(generation)||generation<1
    ||!Number.isInteger(keyVersion)||keyVersion<1
    ||!Number.isInteger(tokenExpiresEpoch)||tokenExpiresEpoch<=0
    ||!/^[a-f0-9]{64}$/.test(tokenNonce)
    ||!/^[a-z0-9/_-]{1,200}$/.test(idempotencyKey)
    ||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(recipient)
    ||templateVersion!=='registration-confirmation-ar-v1'
  )throw new Error('registration_confirmation_delivery_invalid');

  let token:string;
  try{
    token=await deriveConfirmationToken({
      requestId,generation,keyVersion,tokenNonce,tokenExpiresEpoch
    });
  }catch{
    await finishEmailDelivery({
      deliveryId,leaseId,outcome:'retryable',providerMessageId:null,
      httpStatus:null,errorCode:'confirmation_key_unavailable',
      retryAfterSeconds:300
    });
    throw new Error('confirmation_key_unavailable');
  }
  const tokenHash=await sha256(token);
  const message=confirmationMessage({
    email:recipient,
    contactName:clean(claim.contactName,160),
    institutionName:clean(claim.institutionName,240),
    reference:clean(claim.reference,40),
    token
  });
  const contentFingerprint=await sha256(JSON.stringify(message));
  await rpc<JsonRecord>('v1_registration_email_delivery_bind',{
    p_delivery_id:deliveryId,
    p_lease_id:leaseId,
    p_token_hash:tokenHash,
    p_content_fingerprint:contentFingerprint
  });

  let response:Response;
  try{
    response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{
        authorization:`Bearer ${REGISTRATION_RESEND_API_KEY}`,
        'content-type':'application/json',
        'Idempotency-Key':idempotencyKey
      },
      body:JSON.stringify(message),
      signal:AbortSignal.timeout(8_000)
    });
  }catch(error){
    const code=error instanceof DOMException&&error.name==='TimeoutError'
      ?'resend_timeout'
      :'resend_transport_error';
    await finishEmailDelivery({
      deliveryId,leaseId,outcome:'retryable',httpStatus:null,
      providerMessageId:null,errorCode:code,retryAfterSeconds:null
    });
    throw new Error(code);
  }

  if(!response.ok){
    const errorCode=await resendFailureCode(response);
    const retryable=response.status===409
      ?errorCode==='resend_concurrent_idempotent_requests'
      :[408,425,429].includes(response.status)||response.status>=500;
    const completed=await finishEmailDelivery({
      deliveryId,leaseId,
      outcome:retryable?'retryable':'terminal_failed',
      providerMessageId:null,
      httpStatus:response.status,
      errorCode,
      retryAfterSeconds:retryable?retryAfter(response):null
    });
    if(!retryable&&completed.state==='terminal_failed'){
      await rpc<JsonRecord>('v1_registration_email_delivery_fail_safe',{
        p_delivery_id:deliveryId
      });
    }
    throw new Error(errorCode);
  }

  const providerMessageId=await resendMessageId(response);
  if(!providerMessageId){
    // 2xx without a usable id is ambiguous: Resend may have accepted it.  Keep
    // the same generation and key retryable; never rotate or invalidate it.
    await finishEmailDelivery({
      deliveryId,leaseId,outcome:'retryable',providerMessageId:null,
      httpStatus:response.status,errorCode:'resend_invalid_response',
      retryAfterSeconds:null
    });
    throw new Error('resend_invalid_response');
  }

  const completed=await finishEmailDelivery({
    deliveryId,leaseId,outcome:'accepted',providerMessageId,
    httpStatus:response.status,errorCode:null,retryAfterSeconds:null
  });
  if(completed.state!=='accepted'){
    throw new Error('registration_confirmation_delivery_invalid');
  }
  return {deliveryId,state:'accepted',sent:true};
}

async function finishEmailDelivery({
  deliveryId,leaseId,outcome,providerMessageId,httpStatus,errorCode,
  retryAfterSeconds
}:{
  deliveryId:string;
  leaseId:string;
  outcome:'accepted'|'retryable'|'terminal_failed';
  providerMessageId:string|null;
  httpStatus:number|null;
  errorCode:string|null;
  retryAfterSeconds:number|null;
}){
  return await rpc<JsonRecord>('v1_registration_email_delivery_finish',{
    p_delivery_id:deliveryId,
    p_lease_id:leaseId,
    p_outcome:outcome,
    p_provider_message_id:providerMessageId,
    p_http_status:httpStatus,
    p_error_code:errorCode,
    p_retry_after_seconds:retryAfterSeconds
  });
}

async function sendLegacyConfirmation(result:JsonRecord){
  if(
    !registrationEmailTransportReady()
    ||!registrationDomainAttestation().ready
  ){
    throw new PublicError('email_configuration_unavailable',503);
  }
  const token=clean(result._confirmationToken,80).toLowerCase();
  const requestId=clean(result.requestId,48);
  const email=clean(result.contactEmail,240).toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)||!isUuid(requestId)||!email){
    throw new Error('registration_confirmation_payload_invalid');
  }
  const message=confirmationMessage({
    email,contactName:'مسؤول المنشأة',institutionName:'منشأتك',
    reference:clean(result.reference,40),token
  });
  const tokenHash=await sha256(token);
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      authorization:`Bearer ${REGISTRATION_RESEND_API_KEY}`,
      'content-type':'application/json',
      'Idempotency-Key':`odeir-registration-legacy/${requestId}/${tokenHash.slice(0,16)}`
    },
    body:JSON.stringify(message),
    signal:AbortSignal.timeout(8_000)
  });
  if(!response.ok||!await resendMessageId(response)){
    throw new PublicError('confirmation_email_failed',503);
  }
  const marked=await rpc<boolean>('v1_registration_mark_confirmation_sent',{
    p_request_id:requestId,p_token_hash:tokenHash
  });
  if(marked!==true){
    throw new PublicError('confirmation_email_state_unavailable',503);
  }
}

function confirmationMessage({
  email,contactName,institutionName,reference,token
}:{
  email:string;
  contactName:string;
  institutionName:string;
  reference:string;
  token:string;
}){
  const confirmationUrl=new URL('/api/public/registration/confirm',PUBLIC_APP_URL);
  confirmationUrl.searchParams.set('token',token);
  const safeName=escapeHtml(contactName);
  const safeInstitution=escapeHtml(institutionName);
  const safeReference=escapeHtml(reference);
  const safeUrl=escapeHtml(confirmationUrl.toString());
  return {
    from:REGISTRATION_FROM_EMAIL,
    to:[email],
    subject:'أكد بريدك وفعّل مساحة منشأتك في أودير',
    html:`<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f3f7f9;font-family:Tahoma,Arial,sans-serif;color:#0b2942"><div style="max-width:580px;margin:24px auto;padding:28px;background:#fff;border:1px solid #dbe7ec;border-radius:18px"><div style="font-size:12px;font-weight:800;color:#07948d">أودير | منصة إدارة المنشآت</div><h1 style="font-size:25px;line-height:1.5;margin:18px 0 8px">مرحبًا ${safeName}</h1><p style="font-size:14px;line-height:1.9;color:#526b7c">أكد بريدك لتفعيل مساحة <strong>${safeInstitution}</strong> التجريبية. ستعمل وظائف الباقة مباشرة، وتبقى موثوقية المنشأة قيد المراجعة.</p><a href="${safeUrl}" rel="noreferrer" style="display:block;margin:24px 0;padding:15px 18px;border-radius:12px;background:#082f4d;color:#fff;text-align:center;text-decoration:none;font-weight:800">تأكيد البريد وتفعيل المساحة</a><p style="font-size:11px;line-height:1.8;color:#78909e">رقم الطلب: <strong>${safeReference}</strong><br>الرابط أحادي الاستخدام وتنتهي صلاحيته حسب سياسة التسجيل.</p><p style="font-size:10px;color:#91a2ad">إذا لم تطلب التسجيل في أودير، تجاهل هذه الرسالة.</p></div></body></html>`,
    text:`مرحبًا ${contactName}\n\nأكد بريدك لتفعيل مساحة ${institutionName} في أودير:\n${confirmationUrl.toString()}\n\nرقم الطلب: ${reference}`,
    tags:[{name:'category',value:'registration_confirmation'}]
  };
}

async function deriveConfirmationToken({
  requestId,generation,keyVersion,tokenNonce,tokenExpiresEpoch
}:{
  requestId:string;
  generation:number;
  keyVersion:number;
  tokenNonce:string;
  tokenExpiresEpoch:number;
}){
  const canonical=[
    'odeir-registration-confirmation:v1',requestId,String(generation),
    tokenNonce,String(tokenExpiresEpoch)
  ].join('\n');
  const signature=await crypto.subtle.sign(
    'HMAC',await confirmationSigningKey(keyVersion),
    new TextEncoder().encode(canonical)
  );
  return bytesToHex(new Uint8Array(signature));
}

function confirmationSecret(version:number){
  const value=Deno.env.get(
    `ODEIR_REGISTRATION_CONFIRMATION_SECRET_V${version}`
  )?.trim()??'';
  return value.length>=32?value:'';
}

function confirmationSigningKey(version:number){
  let key=confirmationSigningKeys.get(version);
  if(!key){
    const secret=confirmationSecret(version);
    if(!secret)throw new Error('confirmation_key_unavailable');
    key=crypto.subtle.importKey(
      'raw',new TextEncoder().encode(secret),
      {name:'HMAC',hash:'SHA-256'},false,['sign']
    );
    confirmationSigningKeys.set(version,key);
  }
  return key;
}

function retryAfter(response:Response){
  const value=response.headers.get('retry-after')?.trim()??'';
  const seconds=/^\d+$/.test(value)
    ?Number(value)
    :value?Math.ceil((Date.parse(value)-Date.now())/1000):0;
  return Math.max(30,Math.min(3600,Number.isFinite(seconds)?seconds:0));
}

async function resendMessageId(response:Response){
  try{
    const payload=JSON.parse(await response.text()) as JsonRecord;
    const messageId=clean(payload.id,240);
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(messageId)
      ?messageId
      :'';
  }catch{
    return '';
  }
}

async function resendFailureCode(response:Response){
  let providerCode='';
  try{
    const payload=JSON.parse(await response.text()) as JsonRecord;
    providerCode=clean(payload.name??payload.type,48).toLowerCase()
      .replace(/[^a-z0-9]+/g,'_')
      .replace(/^_+|_+$/g,'');
  }catch{
    // The HTTP status still provides a safe, bounded diagnostic.
  }
  const allowedProviderCodes=new Set([
    'application_error','internal_server_error','invalid_access',
    'invalid_api_key','invalid_from_address','invalid_parameter',
    'invalid_region','method_not_allowed','missing_api_key',
    'missing_required_field','not_found','rate_limit_exceeded',
    'validation_error','concurrent_idempotent_requests',
    'invalid_idempotent_request'
  ]);
  const code=allowedProviderCodes.has(providerCode)
    ?`resend_${providerCode}`
    :`resend_http_${response.status}`;
  return code.slice(0,80);
}

async function handleResendWebhook(rawBody:string,request:Request){
  if(!REGISTRATION_RESEND_WEBHOOK_SECRET){
    return json({ok:false,error:'webhook_unavailable'},503);
  }
  const eventId=clean(request.headers.get('svix-id'),160);
  const timestamp=clean(request.headers.get('svix-timestamp'),32);
  const signature=clean(request.headers.get('svix-signature'),1024);
  if(
    !/^[A-Za-z0-9_-]{8,160}$/.test(eventId)
    ||!/^\d{10,13}$/.test(timestamp)
    ||Math.abs(Date.now()-Number(timestamp)*1000)>5*60_000
    ||!await verifySvixSignature(rawBody,eventId,timestamp,signature)
  )return json({ok:false,error:'webhook_signature_invalid'},401);

  let payload:JsonRecord;
  try{
    payload=JSON.parse(rawBody) as JsonRecord;
    if(!payload||Array.isArray(payload)||typeof payload!=='object')throw new Error();
  }catch{return json({ok:false,error:'invalid_json'},400);}

  const eventType=clean(payload.type,64).toLowerCase();
  const supported=new Set([
    'email.sent','email.delivered','email.delivery_delayed','email.bounced',
    'email.complained','email.failed','email.suppressed'
  ]);
  if(!supported.has(eventType))return json({ok:true,ignored:true});
  const data=payload.data;
  if(!data||Array.isArray(data)||typeof data!=='object'){
    return json({ok:false,error:'webhook_payload_invalid'},400);
  }
  const providerMessageId=clean((data as JsonRecord).email_id,240);
  const occurredAt=clean(payload.created_at,64);
  if(
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(providerMessageId)
    ||!Number.isFinite(Date.parse(occurredAt))
  )return json({ok:false,error:'webhook_payload_invalid'},400);

  try{
    const result=await rpc<JsonRecord>(
      'v1_registration_email_delivery_record_event',{
        p_provider_message_id:providerMessageId,
        p_event_id:eventId,
        p_event_type:eventType,
        p_occurred_at:occurredAt
      }
    );
    const canary=await rpc<JsonRecord>(
      'v1_registration_email_canary_record_event',{
        p_provider_message_id:providerMessageId
      }
    );
    return json({
      ok:true,
      duplicate:result.duplicate===true,
      matched:result.matched===true||canary.matched===true
    });
  }catch{
    console.error('odeir-registration-email-webhook','event_persistence_failed');
    return json({ok:false,error:'webhook_persistence_unavailable'},503);
  }
}

async function verifySvixSignature(
  rawBody:string,eventId:string,timestamp:string,header:string
){
  try{
    const secretBytes=base64Decode(
      REGISTRATION_RESEND_WEBHOOK_SECRET.replace(/^whsec_/, '')
    );
    if(secretBytes.byteLength<16)return false;
    const key=await crypto.subtle.importKey(
      'raw',secretBytes,{name:'HMAC',hash:'SHA-256'},false,['verify']
    );
    const signed=new TextEncoder().encode(`${eventId}.${timestamp}.${rawBody}`);
    const candidates=header.split(/\s+/)
      .map(part=>part.split(',',2))
      .filter(parts=>parts[0]==='v1'&&parts[1]);
    for(const [,encoded] of candidates){
      const signatureBytes=base64Decode(encoded);
      if(await crypto.subtle.verify('HMAC',key,signatureBytes,signed))return true;
    }
  }catch{
    // Fail closed without reflecting signature parsing details.
  }
  return false;
}

function base64Decode(value:string){
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));
  return Uint8Array.from(binary,character=>character.charCodeAt(0));
}

async function boundedResponseText(response:Response,maxBytes:number){
  const declared=Number(response.headers.get('content-length')??'0');
  if(declared>maxBytes)throw new Error('response_too_large');
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
  const merged=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(merged);
}

function bytesToHex(bytes:Uint8Array){
  return Array.from(bytes)
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function isMissingRpc(error:unknown,name:string){
  const value=error instanceof Error?error.message:String(error??'');
  return value.includes(name)&&(
    value.includes('PGRST202')
    ||value.toLowerCase().includes('could not find the function')
    ||value.toLowerCase().includes('does not exist')
  );
}

function safeErrorCode(error:unknown){
  const value=error instanceof Error?error.message:String(error??'');
  return value.match(/(?:registration|confirmation|resend|email)_[a-z0-9_]{1,72}/)?.[0]
    ??'delivery_processing_failed';
}

const PUBLIC_DATABASE_ERRORS=new Set([
  'invalid_institution_state','consent_required','institution_name_required',
  'contact_name_required','job_title_required','invalid_email','invalid_phone',
  'registration_identifier_invalid','invalid_external_account',
  'institution_required','registration_payload_invalid',
  'registration_confirmation_invalid','registration_confirmation_already_used',
  'confirmation_email_in_progress','registration_email_canary_rate_limited'
]);

function validatedPayload(body:JsonRecord){
  const institutionState=clean(body.institutionState,20);
  if(!['existing','new'].includes(institutionState)){
    throw new PublicError('invalid_institution_state',400);
  }
  if(body.tvtcAcknowledged!==true||body.privacyConsent!==true){
    throw new PublicError('consent_required',400);
  }
  const accountId=clean(body.accountId,48)||null;
  if(accountId&&!isUuid(accountId))throw new PublicError('invalid_external_account',400);
  if(institutionState==='existing'&&!accountId){
    throw new PublicError('institution_required',400);
  }
  const institutionName=clean(body.institutionName,240);
  const contactName=clean(body.contactName,160);
  const contactJobTitle=clean(body.contactJobTitle,160);
  const contactEmail=clean(body.contactEmail,240).toLowerCase();
  const contactPhone=normalizedPhone(body.contactPhone);
  const commercialRegistration=officialDigits(
    body.commercialRegistration,24
  );
  const nationalRegistration=officialDigits(
    body.nationalRegistration,24
  );
  // TVTC does not publish one universal machine-readable licence format.
  // Preserve the operator value for manual review; the database deliberately
  // does not use it alone as proof for automatic activation.
  const tvtcLicenseNumber=clean(body.tvtcLicenseNumber,80);
  if(institutionName.length<2)throw new PublicError('institution_name_required',400);
  if(contactName.length<2)throw new PublicError('contact_name_required',400);
  if(contactJobTitle.length<2)throw new PublicError('job_title_required',400);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(contactEmail)){
    throw new PublicError('invalid_email',400);
  }
  if(contactPhone.replace(/\D/g,'').length<8){
    throw new PublicError('invalid_phone',400);
  }
  if(
    commercialRegistration&&(
      !/^\d{10}$/.test(commercialRegistration)
      ||allSameDigit(commercialRegistration)
    )
  )throw new PublicError('registration_identifier_invalid',400);
  if(
    nationalRegistration&&(
      !/^7\d{9}$/.test(nationalRegistration)
      ||allSameDigit(nationalRegistration)
    )
  )throw new PublicError('registration_identifier_invalid',400);
  return {
    institutionState,
    accountId,
    institutionName,
    commercialRegistration,
    nationalRegistration,
    tvtcLicenseNumber,
    contactName,
    contactJobTitle,
    contactEmail,
    contactPhone,
    tvtcAcknowledged:true,
    privacyConsent:true
  };
}

async function rpc<T>(name:string,payload:JsonRecord):Promise<T>{
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SERVICE_ROLE_KEY,
      authorization:`Bearer ${SERVICE_ROLE_KEY}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(8_000)
  });
  if(!response.ok){
    const detail=await response.text();
    throw new Error(`rpc_failed:${name}:${response.status}:${detail.slice(0,500)}`);
  }
  return await response.json() as T;
}

function databaseErrorCode(error:unknown){
  const value=error instanceof Error?error.message:String(error??'');
  return [...PUBLIC_DATABASE_ERRORS].find(code=>value.includes(code))
    ??'service_unavailable';
}

function clean(value:unknown,max:number){
  return String(value??'').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ')
    .trim().slice(0,max);
}

function officialDigits(value:unknown,max:number){
  const raw=localizedDigits(clean(value,max*2));
  if(!raw)return '';
  if(!/^[0-9\s-]+$/.test(raw)){
    throw new PublicError('registration_identifier_invalid',400);
  }
  return raw.replace(/[\s-]/g,'').slice(0,max);
}

function allSameDigit(value:string){
  return /^(\d)\1+$/.test(value);
}

function normalizedPhone(value:unknown){
  const raw=localizedDigits(clean(value,40));
  const digits=raw.replace(/\D/g,'').slice(0,15);
  return raw.startsWith('+')?`+${digits}`:digits;
}

function localizedDigits(value:string){
  return value
    .replace(/[٠-٩]/g,digit=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g,digit=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function isUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function escapeHtml(value:unknown){
  return clean(value,300).replace(/[&<>"']/g,character=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[character]??character);
}

async function sha256(value:string){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function hmacSha256(secret:string,value:string){
  const key=await crypto.subtle.importKey(
    'raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign']
  );
  const digest=await crypto.subtle.sign(
    'HMAC',key,new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function secureEqual(left:string,right:string){
  if(!left||!right)return false;
  const [leftHash,rightHash]=await Promise.all([sha256(left),sha256(right)]);
  let difference=leftHash.length^rightHash.length;
  const length=Math.max(leftHash.length,rightHash.length);
  for(let index=0;index<length;index++){
    difference|=(leftHash.charCodeAt(index)||0)^(rightHash.charCodeAt(index)||0);
  }
  return difference===0;
}

function json(payload:unknown,status=200,corsOrigin=''){
  return new Response(JSON.stringify(payload),{
    status,
    headers:corsOrigin?corsHeaders(corsOrigin):JSON_HEADERS
  });
}

class PublicError extends Error{
  code:string;
  status:number;
  constructor(code:string,status:number){
    super(code);this.code=code;this.status=status;
  }
}
