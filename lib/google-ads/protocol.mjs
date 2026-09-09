import {createHash,randomBytes} from 'node:crypto';

export const CALLBACK_PATH='/api/tenant/google-ads/callback';
const SLUG=/^[a-z0-9][a-z0-9-]{1,79}$/;

export function eligibleSlug(value){return typeof value==='string'&&SLUG.test(value)&&!['reef-skills','reefskills'].includes(value);}
export function digest(value){return createHash('sha256').update(value).digest('hex');}
export function stateCookieName(state){return /^[a-f0-9]{64}$/.test(state||'')?'__Host-odeir_google_state_'+digest(state):'';}
export function validVerifier(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(value);}
export function pkceChallenge(value){return createHash('sha256').update(value).digest('base64url');}
export function newBrowserTransaction(){
  const state=randomBytes(32).toString('hex');
  const verifier=randomBytes(48).toString('base64url');
  return {state,verifier,codeChallenge:pkceChallenge(verifier)};
}
export function publicRequestOrigin(request){
  const url=new URL(request.url);
  const hosts=new Set(['odeir.com','staging.odeir.com']);
  const forwarded=request.headers.get('x-forwarded-host');
  if(forwarded)return hosts.has(forwarded)&&request.headers.get('x-forwarded-proto')==='https'?'https://'+forwarded:'';
  if(hosts.has(url.hostname)&&url.protocol==='https:'&&!url.port)return url.origin;
  if(['localhost','127.0.0.1'].includes(url.hostname))return url.origin;
  return '';
}
export function sameOriginMutation(request){
  const origin=publicRequestOrigin(request);
  return Boolean(origin&&request.headers.get('origin')===origin
    &&request.headers.get('sec-fetch-site')!=='cross-site'
    &&request.headers.get('content-type')?.split(';')[0].trim()==='application/json');
}
export function trustedAuthorizeUrl(value,origin,transaction){
  const url=new URL(value);
  if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth'
    ||url.username||url.password||url.hash
    ||url.searchParams.get('redirect_uri')!==origin+CALLBACK_PATH
    ||url.searchParams.get('state')!==transaction.state
    ||url.searchParams.get('code_challenge')!==transaction.codeChallenge
    ||url.searchParams.get('code_challenge_method')!=='S256'
    ||url.searchParams.get('response_type')!=='code'
    ||url.searchParams.get('scope')!=='https://www.googleapis.com/auth/adwords')throw new Error('invalid_authorization_url');
  return url.toString();
}
export function safeCompletionPath(value){
  try{
    if(typeof value!=='string'||!value.startsWith('/'))return '/';
    const url=new URL(value,'https://odeir.invalid');
    const match=url.pathname.match(/^\/tenant\/([a-z0-9][a-z0-9-]{1,79})\/reports\/google-ads$/);
    if(url.origin!=='https://odeir.invalid'||!match||!eligibleSlug(match[1]))return '/';
    // Only our status parameters survive the OAuth redirect.
    const status=url.searchParams.get('google_ads');
    return url.pathname+(status&&['connected','cancelled','error'].includes(status)?'?google_ads='+status:'');
  }catch{return '/';}
}
