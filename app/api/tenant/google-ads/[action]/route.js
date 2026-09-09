import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {
  eligibleSlug,newBrowserTransaction,publicRequestOrigin,safeCompletionPath,
  sameOriginMutation,stateCookieName,trustedAuthorizeUrl,validVerifier
} from '../../../../../lib/google-ads/protocol.mjs';
import {boundedJson,publicError} from '../../../../../supabase/functions/google-ads-connect/handler.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=150;
const ACTIONS=new Set(['start','assets','select','sync','disconnect','sources','review']);
const COOKIE_OPTIONS={httpOnly:true,secure:true,sameSite:'lax',path:'/'};
function json(body,status=200){return NextResponse.json(body,{status,headers:{
  'cache-control':'private, no-store, max-age=0','x-content-type-options':'nosniff','referrer-policy':'no-referrer'
}});}
async function edge(action,body,accessToken){
  return fetch(`${SUPABASE_URL}/functions/v1/google-ads-connect/${action}`,{
    method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${accessToken}`,'content-type':'application/json'},
    body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(action==='sync'?140_000:60_000)
  });
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action))return json({ok:false,error:'not_found'},404);
    if(!sameOriginMutation(request))return json({ok:false,error:'forbidden'},403);
    const accessToken=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!accessToken)return json({ok:false,error:'authentication_required'},401);
    const body=await boundedJson(request);
    const tenantSlug=body.tenantSlug;
    if(!eligibleSlug(tenantSlug))return json({ok:false,error:'forbidden'},403);
    const transaction=action==='start'?newBrowserTransaction():null;
    const payload={tenantSlug};
    if(transaction)Object.assign(payload,{state:transaction.state,codeChallenge:transaction.codeChallenge,
      returnPath:`/tenant/${tenantSlug}/reports/google-ads`});
    if(action==='select')payload.accountId=body.accountId;
    if(action==='sync')Object.assign(payload,{dateFrom:body.dateFrom,dateTo:body.dateTo,commandId:body.commandId||crypto.randomUUID()});
    if(action==='sources')payload.offset=body.offset??0;
    if(action==='review')Object.assign(payload,{rows:body.rows,campaignId:body.campaignId,commandId:body.commandId,reason:body.reason});
    const response=await edge(action,payload,accessToken);
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true)return json({ok:false,error:publicError(result.error)},response.ok?502:response.status);
    if(transaction){
      const authorizeUrl=trustedAuthorizeUrl(result.authorizeUrl,publicRequestOrigin(request),transaction);
      const reply=json({ok:true,authorizeUrl});
      reply.cookies.set(stateCookieName(transaction.state),transaction.verifier,{...COOKIE_OPTIONS,maxAge:600});
      return reply;
    }
    return json(result);
  }catch(error){
    const code=publicError(error);
    return json({ok:false,error:code},code==='payload_too_large'?413:code==='invalid_request'?400:503);
  }
}

export async function GET(request,{params}){
  if((await params).action!=='callback')return json({ok:false,error:'not_found'},404);
  const origin=publicRequestOrigin(request);
  if(!origin)return json({ok:false,error:'forbidden'},403);
  const url=new URL(request.url);
  const state=url.searchParams.get('state')||'';
  const cookieName=stateCookieName(state);
  const jar=await cookies();
  const verifier=cookieName?jar.get(cookieName)?.value:'';
  const accessToken=jar.get(ACCESS_COOKIE)?.value;
  function finish(path){
    const response=NextResponse.redirect(new URL(path,origin),303);
    response.headers.set('cache-control','private, no-store, max-age=0');
    response.headers.set('referrer-policy','no-referrer');
    if(cookieName&&validVerifier(verifier))response.cookies.set(cookieName,'',{...COOKIE_OPTIONS,maxAge:0});
    return response;
  }
  if(!accessToken||!validVerifier(verifier))return finish('/?google_ads=error');
  try{
    const response=await edge('complete',{state,codeVerifier:verifier,code:url.searchParams.get('code')||'',
      cancelled:url.searchParams.has('error')},accessToken);
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.ok)return finish('/?google_ads=error');
    return finish(safeCompletionPath(result.returnPath));
  }catch{return finish('/?google_ads=error');}
}
