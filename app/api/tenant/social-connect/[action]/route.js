import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL
} from '../../../../../lib/config';
import {
  matchesBrowserState,sameOriginMutation,
  safeCompletionPath,stateCookieName,stateDigest,trustedAuthorizeUrl,publicRequestOrigin
} from '../../../../../lib/social-connect-protocol.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=150;

const ACTIONS=new Set(['start','disconnect','assets','select','sync']);
const DATE_ONLY=/^\d{4}-\d{2}-\d{2}$/;

function json(body,status=200){
  return NextResponse.json(body,{
    status,
    headers:{
      'cache-control':'private, no-store, max-age=0',
      'x-content-type-options':'nosniff'
    }
  });
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!ACTIONS.has(action))return json({ok:false,error:'not_found'},404);
    if(!sameOriginMutation(request))return json({ok:false,error:'forbidden'},403);
    const accessToken=(await cookies()).get(ACCESS_COOKIE)?.value||'';
    if(!accessToken)return json({ok:false,error:'session_expired'},401);
    const body=await request.json().catch(()=>({}));
    const tenantSlug=String(body.tenantSlug||'').trim();
    if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(tenantSlug)){
      return json({ok:false,error:'invalid_tenant'},400);
    }
    const dateFrom=String(body.dateFrom||'').trim();
    const dateTo=String(body.dateTo||'').trim();
    if(action==='sync'&&(
      Boolean(dateFrom)!==Boolean(dateTo)
      ||(dateFrom&&!DATE_ONLY.test(dateFrom))
      ||(dateTo&&!DATE_ONLY.test(dateTo))
    ))return json({ok:false,error:'marketing_sync_range_invalid'},400);
    const edgeBody=action==='start'
      ?{
        tenantSlug,
        returnPath:`/tenant/${encodeURIComponent(tenantSlug)}/addons/social-connect`
      }
      :action==='select'
        ?{tenantSlug,externalAccountId:String(body.externalAccountId||'').trim()}
        :action==='sync'
          ?{
            tenantSlug,provider:'meta',action:'sync_now',source:'social_connect',
            ...(dateFrom&&dateTo?{dateFrom,dateTo}:{})
          }
          :{tenantSlug};
    const functionName=action==='sync'?'ads-sync':'meta-oauth-v2';
    const functionRoute=action==='sync'?'':`/${action}`;
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${functionName}${functionRoute}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          authorization:`Bearer ${accessToken}`,
          'content-type':'application/json'
        },
        body:JSON.stringify(edgeBody),
        cache:'no-store',
        signal:AbortSignal.timeout(action==='sync'?140_000:15_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    if(!response.ok){
      return json({ok:false,error:publicError(result?.error)},response.status);
    }
    if(action==='start'){
      const authorizeUrl=String(result.authorizeUrl||'');
      const parsed=trustedAuthorizeUrl(authorizeUrl,publicRequestOrigin(request));
      const reply=json({ok:true,authorizeUrl,expiresIn:result.expiresIn});
      reply.cookies.set(stateCookieName(parsed.searchParams.get('state')),stateDigest(parsed.searchParams.get('state')),{
        httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600
      });
      return reply;
    }
    if(action==='assets')return json({ok:true,accounts:result.accounts||[]});
    if(action==='select')return json({ok:true,
      status:result.status,externalAccountId:result.externalAccountId
    });
    if(action==='sync')return json({ok:true,status:result.status,stats:result.stats||{}});
    return json({ok:true,status:result.status});
  }catch(error){
    console.error('[social-connect-v2-route]',
      error instanceof Error?error.name:'unknown_error'
    );
    return json({ok:false,error:'service_unavailable'},503);
  }
}

// Meta returns to ODEIR so both the initiating browser and authenticated subject
// are checked before the server exchanges the authorization code.
export async function GET(request,{params}){
  if((await params).action!=='callback')return json({ok:false,error:'not_found'},404);
  const url=new URL(request.url);
  const origin=publicRequestOrigin(request);
  if(!origin)return json({ok:false,error:'forbidden'},403);
  const jar=await cookies();
  const state=url.searchParams.get('state')||'';
  const cookieName=stateCookieName(state);
  const browserMatches=Boolean(cookieName&&matchesBrowserState(state,jar.get(cookieName)?.value));
  const accessToken=jar.get(ACCESS_COOKIE)?.value||'';
  function finish(path){
    const response=NextResponse.redirect(new URL(path,origin),303);
    response.headers.set('cache-control','private, no-store, max-age=0');
    response.headers.set('referrer-policy','no-referrer');
    if(browserMatches)response.cookies.set(cookieName,'',{
      httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:0
    });
    return response;
  }
  if(!accessToken||!browserMatches){
    return finish('/?social_connect=error&reason=oauth_session_mismatch');
  }
  try{
    const response=await fetch(`${SUPABASE_URL}/functions/v1/meta-oauth-v2/complete`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${accessToken}`,
        'content-type':'application/json'},
      body:JSON.stringify({state,code:url.searchParams.get('code')||'',
        cancelled:url.searchParams.has('error')}),
      cache:'no-store',signal:AbortSignal.timeout(55_000)
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.returnPath){
      return finish('/?social_connect=error&reason=request_rejected');
    }
    return finish(safeCompletionPath(result.returnPath));
  }catch{
    return finish('/?social_connect=error&reason=service_unavailable');
  }
}

function publicError(code){
  const allowed=new Set([
    'authentication_required','forbidden','addon_not_enabled',
    'meta_connect_v2_not_in_rollout','meta_connect_v2_oauth_disabled',
    'legacy_meta_connection_present','service_unavailable'
    ,'meta_connect_v2_capability_disabled',
    'meta_connect_v2_reauthorization_required',
    'meta_connect_v2_account_invalid',
    'meta_connect_v2_account_not_available',
    'meta_asset_discovery_failed','marketing_connection_not_found',
    'marketing_sync_range_invalid','marketing_configuration_invalid'
  ]);
  return allowed.has(code)?code:'request_rejected';
}
