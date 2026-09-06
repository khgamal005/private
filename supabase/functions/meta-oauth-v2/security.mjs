const encoder=new TextEncoder();
const decoder=new TextDecoder();

export function base64UrlEncode(bytes){
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g,'-')
    .replace(/\//g,'_')
    .replace(/=+$/,'');
}

export function base64UrlDecode(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)){
    throw new Error('invalid_base64url');
  }
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  try{
    return Uint8Array.from(atob(padded),character=>character.charCodeAt(0));
  }catch{
    throw new Error('invalid_base64url');
  }
}

export async function sha256Hex(value){
  const bytes=typeof value==='string'?encoder.encode(value):value;
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest)
    .map(byte=>byte.toString(16).padStart(2,'0'))
    .join('');
}

export async function hmacSha256Hex(value,secret){
  if(typeof value!=='string'||typeof secret!=='string'||secret.length<16){
    throw new Error('invalid_hmac_input');
  }
  const key=await crypto.subtle.importKey(
    'raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']
  );
  const signature=new Uint8Array(await crypto.subtle.sign(
    'HMAC',key,encoder.encode(value)
  ));
  return Array.from(signature)
    .map(byte=>byte.toString(16).padStart(2,'0'))
    .join('');
}

export function randomHex(byteLength=32){
  if(!Number.isInteger(byteLength)||byteLength<16||byteLength>64){
    throw new Error('invalid_random_length');
  }
  const bytes=crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map(byte=>byte.toString(16).padStart(2,'0'))
    .join('');
}

export function validReturnPath(value){
  return typeof value==='string'
    &&value.length>=1
    &&value.length<=500
    &&value.startsWith('/')
    &&!value.startsWith('//')
    &&!value.includes('\\')
    &&!/[\u0000-\u001f\u007f]/.test(value);
}

export function safeReturnUrl(origin,returnPath,params={}){
  if(!validReturnPath(returnPath))throw new Error('invalid_return_path');
  const base=new URL(origin);
  if(base.pathname!=='/'||base.search||base.hash){
    throw new Error('invalid_return_origin');
  }
  if(base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname)){
    throw new Error('invalid_return_origin');
  }
  const target=new URL(returnPath,base);
  if(target.origin!==base.origin)throw new Error('invalid_return_path');
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined&&value!==null)target.searchParams.set(key,String(value));
  }
  return target.toString();
}

export async function verifySignedRequest(value,secret,options={}){
  const maxAgeSeconds=options.maxAgeSeconds??900;
  const nowSeconds=options.nowSeconds??Math.floor(Date.now()/1000);
  if(typeof value!=='string'||value.length<20||value.length>16_000){
    throw new Error('signed_request_invalid');
  }
  if(typeof secret!=='string'||secret.length<16){
    throw new Error('signed_request_unavailable');
  }
  const parts=value.split('.');
  if(parts.length!==2||parts.some(part=>!part)){
    throw new Error('signed_request_invalid');
  }
  const [encodedSignature,encodedPayload]=parts;
  let signature;
  let payload;
  try{
    signature=base64UrlDecode(encodedSignature);
    payload=JSON.parse(decoder.decode(base64UrlDecode(encodedPayload)));
  }catch{
    throw new Error('signed_request_invalid');
  }
  if(!payload||Array.isArray(payload)||typeof payload!=='object'){
    throw new Error('signed_request_invalid');
  }
  const algorithm=String(payload.algorithm||'').toUpperCase();
  const userId=String(payload.user_id||'');
  const issuedAt=Number(payload.issued_at||0);
  if(
    algorithm!=='HMAC-SHA256'
    ||!/^[A-Za-z0-9_-]{1,120}$/.test(userId)
    ||!Number.isInteger(issuedAt)
    ||issuedAt>nowSeconds+60
    ||issuedAt<nowSeconds-maxAgeSeconds
  ){
    throw new Error('signed_request_invalid');
  }
  const key=await crypto.subtle.importKey(
    'raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']
  );
  const valid=await crypto.subtle.verify(
    'HMAC',key,signature,encoder.encode(encodedPayload)
  );
  if(!valid)throw new Error('signed_request_invalid');
  return {userId,issuedAt,payload};
}

export function normalizedGraphVersion(value){
  const version=String(value||'');
  if(!/^v[1-9][0-9]*\.[0-9]+$/.test(version)){
    throw new Error('invalid_graph_version');
  }
  return version;
}
