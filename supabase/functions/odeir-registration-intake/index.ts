import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get('SUPABASE_URL')??'';
const SERVICE_ROLE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
const INTAKE_TOKEN=Deno.env.get('ODEIR_REGISTRATION_INGRESS_TOKEN')??'';
const RATE_SALT=Deno.env.get('ODEIR_REGISTRATION_RATE_SALT')
  ||INTAKE_TOKEN
  ||SERVICE_ROLE_KEY;
const RESEND_API_KEY=Deno.env.get('RESEND_API_KEY')??'';
const REGISTRATION_FROM_EMAIL=Deno.env.get('ODEIR_REGISTRATION_FROM_EMAIL')
  ||Deno.env.get('RESEND_FROM')
  ||'';
const PUBLIC_APP_URL=Deno.env.get('ODEIR_PUBLIC_APP_URL')
  ||'https://odeir.com';

const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, max-age=0',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'
};

type JsonRecord=Record<string,unknown>;

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST')return json({ok:false,error:'method_not_allowed'},405);
  if(!SUPABASE_URL||!SERVICE_ROLE_KEY||RATE_SALT.length<32){
    return json({ok:false,error:'service_unavailable'},503);
  }
  if(Number(request.headers.get('content-length')??'0')>16_384){
    return json({ok:false,error:'request_too_large'},413);
  }
  if(!await authorizedServerRequest(request)){
    return json({ok:false,error:'unauthorized'},401);
  }

  const rawBody=await request.text();
  if(new TextEncoder().encode(rawBody).byteLength>16_384){
    return json({ok:false,error:'request_too_large'},413);
  }
  let body:JsonRecord;
  try{
    body=JSON.parse(rawBody);
    if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();
  }catch{return json({ok:false,error:'invalid_json'},400);}

  if(clean(body.website,120))return json({ok:true,ignored:true});
  const action=clean(body.action,24);
  if(action==='health'){
    return json({
      ok:true,
      emailReady:Boolean(
        RESEND_API_KEY&&REGISTRATION_FROM_EMAIL&&PUBLIC_APP_URL
      )
    });
  }
  if(action==='confirm'){
    return confirmRegistration(body,request);
  }
  if(action!=='submit'){
    return json({ok:false,error:'invalid_action'},400);
  }
  const startedAt=Number(body.startedAt??0);
  const elapsed=Date.now()-startedAt;
  if(!startedAt||elapsed<700||elapsed>7_200_000){
    return json({ok:false,error:'invalid_session'},400);
  }

  try{
    const payload=validatedPayload(body);
    const clientIp=clean(request.headers.get('x-odeir-client-ip'),80)||'unknown';
    const userAgent=clean(request.headers.get('x-odeir-user-agent'),300);
    const ipHash=await sha256(`${clientIp}|${RATE_SALT}`);
    const userAgentHash=userAgent?await sha256(`${userAgent}|${RATE_SALT}`):null;
    const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`submit:${ipHash}`,
      p_limit:3,
      p_window_seconds:86_400
    });
    if(!allowed)return json({ok:false,error:'rate_limited'},429);

    const result=await rpc<JsonRecord>('v1_public_submit_registration_request',{
      p_payload:payload,
      p_ip_hash:ipHash,
      p_user_agent_hash:userAgentHash
    });
    if(result.confirmationRequired===true&&result.confirmationAlreadySent!==true){
      const confirmationToken=clean(result._confirmationToken,80);
      const requestId=clean(result.requestId,48);
      const contactEmail=clean(result.contactEmail,240).toLowerCase();
      if(!confirmationToken||!isUuid(requestId)||!contactEmail){
        throw new Error('registration_confirmation_payload_invalid');
      }
      await sendConfirmationEmail({
        requestId,
        reference:clean(result.reference,40),
        email:contactEmail,
        contactName:payload.contactName,
        institutionName:payload.institutionName,
        token:confirmationToken
      });
      await rpc<boolean>('v1_registration_mark_confirmation_sent',{
        p_request_id:requestId,
        p_token_hash:await sha256(confirmationToken)
      });
    }
    const publicResult={...result};
    delete publicResult._confirmationToken;
    delete publicResult.contactEmail;
    delete publicResult.requestId;
    return json({ok:true,...publicResult},result.duplicate===true?200:201);
  }catch(error){
    if(error instanceof PublicError){
      return json({ok:false,error:error.code},error.status);
    }
    const code=databaseErrorCode(error);
    const publicCode=PUBLIC_DATABASE_ERRORS.has(code)?code:'service_unavailable';
    console.error('odeir-registration-intake',publicCode);
    return json({ok:false,error:publicCode},publicCode==='service_unavailable'?503:400);
  }
});

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

function looksLikeJwt(value:string){
  return value.split('.').length===3;
}

async function confirmRegistration(body:JsonRecord,request:Request){
  const token=clean(body.token,80).toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return json({ok:false,error:'registration_confirmation_invalid'},400);
  }
  try{
    const clientIp=clean(request.headers.get('x-odeir-client-ip'),80)||'unknown';
    const ipHash=await sha256(`${clientIp}|${RATE_SALT}`);
    const allowed=await rpc<boolean>('v1_registration_rate_limit_consume',{
      p_rate_key:`confirm:${ipHash}`,
      p_limit:12,
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

async function sendConfirmationEmail({
  requestId,reference,email,contactName,institutionName,token
}:{
  requestId:string;
  reference:string;
  email:string;
  contactName:string;
  institutionName:string;
  token:string;
}){
  if(!RESEND_API_KEY||!REGISTRATION_FROM_EMAIL||!PUBLIC_APP_URL){
    throw new PublicError('email_configuration_unavailable',503);
  }
  let confirmationUrl:URL;
  try{
    confirmationUrl=new URL('/api/public/registration/confirm',PUBLIC_APP_URL);
  }catch{
    throw new PublicError('email_configuration_unavailable',503);
  }
  if(confirmationUrl.protocol!=='https:'&&confirmationUrl.hostname!=='localhost'){
    throw new PublicError('email_configuration_unavailable',503);
  }
  confirmationUrl.searchParams.set('token',token);
  const safeName=escapeHtml(contactName);
  const safeInstitution=escapeHtml(institutionName);
  const safeReference=escapeHtml(reference);
  const safeUrl=escapeHtml(confirmationUrl.toString());
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      authorization:`Bearer ${RESEND_API_KEY}`,
      'content-type':'application/json',
      'idempotency-key':`odeir-registration-${requestId}-${(await sha256(token)).slice(0,16)}`
    },
    body:JSON.stringify({
      from:REGISTRATION_FROM_EMAIL,
      to:[email],
      subject:'أكد بريدك وفعّل مساحة منشأتك في أودير',
      html:`<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f3f7f9;font-family:Tahoma,Arial,sans-serif;color:#0b2942"><div style="max-width:580px;margin:24px auto;padding:28px;background:#fff;border:1px solid #dbe7ec;border-radius:18px"><div style="font-size:12px;font-weight:800;color:#07948d">أودير | منصة إدارة المنشآت</div><h1 style="font-size:25px;line-height:1.5;margin:18px 0 8px">مرحبًا ${safeName}</h1><p style="font-size:14px;line-height:1.9;color:#526b7c">أكد بريدك لتفعيل مساحة <strong>${safeInstitution}</strong> التجريبية. ستعمل وظائف الباقة مباشرة، وتبقى موثوقية المنشأة قيد المراجعة.</p><a href="${safeUrl}" style="display:block;margin:24px 0;padding:15px 18px;border-radius:12px;background:#082f4d;color:#fff;text-align:center;text-decoration:none;font-weight:800">تأكيد البريد وتفعيل المساحة</a><p style="font-size:11px;line-height:1.8;color:#78909e">رقم الطلب: <strong>${safeReference}</strong><br>الرابط أحادي الاستخدام وتنتهي صلاحيته حسب سياسة التسجيل.</p><p style="font-size:10px;color:#91a2ad">إذا لم تطلب التسجيل في أودير، تجاهل هذه الرسالة.</p></div></body></html>`,
      text:`مرحبًا ${contactName}\n\nأكد بريدك لتفعيل مساحة ${institutionName} في أودير:\n${confirmationUrl.toString()}\n\nرقم الطلب: ${reference}`
    }),
    signal:AbortSignal.timeout(8_000)
  });
  if(!response.ok){
    throw new PublicError('confirmation_email_failed',503);
  }
}

const PUBLIC_DATABASE_ERRORS=new Set([
  'invalid_institution_state','consent_required','institution_name_required',
  'contact_name_required','job_title_required','invalid_email','invalid_phone',
  'registration_identifier_invalid','invalid_external_account',
  'institution_required','registration_payload_invalid',
  'registration_confirmation_invalid','registration_confirmation_already_used'
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
  if(institutionName.length<2)throw new PublicError('institution_name_required',400);
  if(contactName.length<2)throw new PublicError('contact_name_required',400);
  if(contactJobTitle.length<2)throw new PublicError('job_title_required',400);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(contactEmail)){
    throw new PublicError('invalid_email',400);
  }
  if(contactPhone.replace(/\D/g,'').length<8){
    throw new PublicError('invalid_phone',400);
  }
  return {
    institutionState,
    accountId,
    institutionName,
    commercialRegistration:digitsOnly(body.commercialRegistration,24),
    nationalRegistration:digitsOnly(body.nationalRegistration,24),
    tvtcLicenseNumber:clean(body.tvtcLicenseNumber,80),
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

function digitsOnly(value:unknown,max:number){
  return clean(value,max*2).replace(/\D/g,'').slice(0,max);
}

function normalizedPhone(value:unknown){
  const raw=clean(value,40);
  const digits=raw.replace(/\D/g,'').slice(0,15);
  return raw.startsWith('+')?`+${digits}`:digits;
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

function json(payload:unknown,status=200){
  return new Response(JSON.stringify(payload),{status,headers:JSON_HEADERS});
}

class PublicError extends Error{
  code:string;
  status:number;
  constructor(code:string,status:number){
    super(code);this.code=code;this.status=status;
  }
}
