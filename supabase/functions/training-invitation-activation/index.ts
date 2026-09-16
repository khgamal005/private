// Learners never receive employee memberships. The invitation claim is the only
// service-role lookup; final acceptance executes with the real learner session.
type RecordValue=Record<string,unknown>;
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(body:RecordValue,status=200)=>new Response(JSON.stringify(body),{status,headers});
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text=(value:unknown)=>typeof value==='string'?value:'';

async function readBody(request:Request){
  const reader=request.body?.getReader();if(!reader)throw Error('invalid_request');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw Error('invalid_request');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  const body=JSON.parse(new TextDecoder().decode(buffer));
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_request');
  return body as RecordValue;
}

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')return json({error:'invalid_request'},415);
  const base=Deno.env.get('SUPABASE_URL')?.trim();
  const publicKey=Deno.env.get('SUPABASE_ANON_KEY')?.trim()||Deno.env.get('SUPABASE_PUBLISHABLE_KEY')?.trim();
  const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if(!base||!publicKey||!serviceKey)return json({error:'server_not_configured'},503);
  let tokenHash='';let claimId='';let claimed=false;
  async function post(path:string,body:RecordValue,{service=false,token=''}={}){
    const key=service?serviceKey!:publicKey!;
    const response=await fetch(`${base}${path}`,{method:'POST',headers:{apikey:key,'content-type':'application/json',...(service||token?{authorization:`Bearer ${service?serviceKey:token}`} : {})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
    const data=await response.json().catch(()=>({})) as RecordValue;
    return {ok:response.ok,status:response.status,data};
  }
  async function release(){
    if(claimed)await post('/rest/v1/rpc/v1_training_invitation_activation',{p_token_hash:tokenHash,p_claim_id:claimId,p_action:'release'},{service:true}).catch(()=>{});
  }
  try{
    const body=await readBody(request);
    const token=text(body.token),password=text(body.password);
    claimId=text(body.claimId);
    if(!/^[0-9a-f]{64}$/.test(token)||!uuid(claimId))return json({error:'invalid_invitation'},400);
    if(password.length<12||password.length>256)return json({error:'weak_password'},400);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    tokenHash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    const claim=await post('/rest/v1/rpc/v1_training_invitation_activation',{p_token_hash:tokenHash,p_claim_id:claimId,p_action:'claim'},{service:true});
    if(!claim.ok)return json({error:'invalid_invitation'},400);
    claimed=true;
    const email=text(claim.data.email).trim().toLowerCase();
    if(!email||claim.data.tenantSlug!=='marktone')throw Error('invalid_invitation');
    // No search of all Auth users, no reset/update of an existing account.
    const created=await post('/auth/v1/admin/users',{email,password,email_confirm:true,user_metadata:{full_name:text(claim.data.fullName)}},{service:true});
    if(!created.ok){
      await release();
      const code=text(created.data.error_code)||text(created.data.code);
      const exists=['email_exists','user_already_exists','email_address_exists'].includes(code)||created.status===422;
      return json({error:exists?'account_already_exists':'activation_failed'},exists?409:503);
    }
    const signed=await post('/auth/v1/token?grant_type=password',{email,password});
    if(!signed.ok){await release();return json({error:'account_already_exists'},409);}
    const accessToken=text(signed.data.access_token);
    if(!accessToken)throw Error('activation_failed');
    const accepted=await post('/rest/v1/rpc/v1_training_learning_action',{
      p_tenant_slug:'marktone',p_action:'accept_invitation',p_command_id:claimId,p_payload:{tokenHash}
    },{token:accessToken});
    if(!accepted.ok){await release();return json({error:'activation_failed'},409);}
    claimed=false;
    return json({success:true,session:{access_token:accessToken,refresh_token:signed.data.refresh_token,expires_in:signed.data.expires_in}});
  }catch{
    await release();
    // Deliberately never return/log credentials, tokens, identities or SQL errors.
    return json({error:'activation_failed'},503);
  }
});
