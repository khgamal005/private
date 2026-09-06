import {createHash,timingSafeEqual} from 'node:crypto';

export const SOCIAL_STATE_COOKIE='__Host-odeir_social_state';
export const SOCIAL_CALLBACK_PATH='/api/tenant/social-connect/callback';

export function stateDigest(state){
  if(typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state))return '';
  return createHash('sha256').update(state).digest('hex');
}

export function stateCookieName(state){
  const digest=stateDigest(state);
  return digest?SOCIAL_STATE_COOKIE+'_'+digest:'';
}

export function matchesBrowserState(state,expected){
  const actual=stateDigest(state);
  return Boolean(actual&&typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected)
    &&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex')));
}

export function sameOriginMutation(request){
  const origin=request.headers.get('origin');
  return Boolean(origin&&origin===publicRequestOrigin(request)
    &&request.headers.get('sec-fetch-site')!=='cross-site'
    &&request.headers.get('content-type')?.split(';')[0].trim()==='application/json');
}

export function publicRequestOrigin(request){
  const url=new URL(request.url);
  const forwarded=request.headers.get('x-forwarded-host');
  const hosts=new Set(['odeir.com','staging.odeir.com']);
  if(forwarded){
    return hosts.has(forwarded)&&request.headers.get('x-forwarded-proto')==='https'
      ?'https://'+forwarded:'';
  }
  if(hosts.has(url.hostname)&&url.protocol==='https:'&&!url.port)return url.origin;
  if(['localhost','127.0.0.1'].includes(url.hostname))return url.origin;
  return '';
}

export function trustedAuthorizeUrl(value,origin){
  const url=new URL(value);
  if(url.origin!=='https://www.facebook.com'||url.username||url.password
    ||!/^\/v[1-9][0-9]*\.0\/dialog\/oauth$/.test(url.pathname)
    ||url.searchParams.get('redirect_uri')!==origin+SOCIAL_CALLBACK_PATH
    ||!stateDigest(url.searchParams.get('state'))){
    throw new Error('invalid_authorization_url');
  }
  return url;
}

export function safeCompletionPath(value){
  if(typeof value!=='string')return '/';
  const url=new URL(value,'https://odeir.invalid');
  if(url.origin!=='https://odeir.invalid'
    ||!/^\/tenant\/[a-z0-9][a-z0-9-]{1,79}\/addons\/social-connect$/.test(url.pathname))return '/';
  return url.pathname+url.search;
}
