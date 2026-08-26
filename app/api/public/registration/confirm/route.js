import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

const EDGE_FUNCTION='odeir-registration-intake';
const CONFIRM_COOKIE='odeir_registration_confirm';

export async function GET(request){
  const token=String(request.nextUrl.searchParams.get('token')||'')
    .trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return redirectState(request,'invalid');
  }
  const destination=new URL('/registration-confirmation',request.nextUrl.origin);
  destination.searchParams.set('state','ready');
  const response=privateRedirect(destination);
  response.cookies.set(CONFIRM_COOKIE,token,{
    httpOnly:true,
    secure:process.env.NODE_ENV==='production',
    sameSite:'strict',
    path:'/api/public/registration/confirm',
    maxAge:10*60
  });
  return response;
}

export async function POST(request){
  const origin=request.headers.get('origin');
  if(origin&&origin!==request.nextUrl.origin){
    return clearConfirmCookie(redirectState(request,'invalid'));
  }
  const token=String(request.cookies.get(CONFIRM_COOKIE)?.value||'')
    .trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return clearConfirmCookie(redirectState(request,'invalid'));
  }
  const ingressToken=(process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'').trim();
  if(ingressToken.length<32){
    console.error('odeir_registration_confirmation_failed',{
      errorName:'IngressTokenUnavailable'
    });
    return clearConfirmCookie(redirectState(request,'unavailable'));
  }

  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'content-type':'application/json',
          'x-odeir-intake-token':ingressToken,
          'x-odeir-client-ip':clientIp(request),
          'x-odeir-user-agent':clean(request.headers.get('user-agent'),300)
        },
        body:JSON.stringify({action:'confirm',token}),
        cache:'no-store',
        signal:AbortSignal.timeout(30_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true){
      return clearConfirmCookie(redirectState(request,
        result.error==='registration_confirmation_invalid'?'invalid':'unavailable'));
    }
    if(result.manualReviewRequired===true){
      return clearConfirmCookie(redirectState(request,'manual_review'));
    }
    if(typeof result.invitationToken==='string'&&result.invitationToken.length>=32){
      const destination=new URL('/accept-invite',request.nextUrl.origin);
      destination.searchParams.set('token',result.invitationToken);
      destination.searchParams.set('source','email-confirmed-registration');
      return clearConfirmCookie(privateRedirect(destination));
    }
    const destination=new URL('/login',request.nextUrl.origin);
    destination.searchParams.set('reason','registration_confirmed');
    if(result.tenantSlug)destination.searchParams.set('tenant',String(result.tenantSlug));
    return clearConfirmCookie(privateRedirect(destination));
  }catch(error){
    console.error('odeir_registration_confirmation_failed',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return clearConfirmCookie(redirectState(request,'unavailable'));
  }
}

function clearConfirmCookie(response){
  response.cookies.set(CONFIRM_COOKIE,'',{
    httpOnly:true,
    secure:process.env.NODE_ENV==='production',
    sameSite:'strict',
    path:'/api/public/registration/confirm',
    maxAge:0
  });
  return response;
}

function redirectState(request,state){
  const destination=new URL('/registration-confirmation',request.nextUrl.origin);
  destination.searchParams.set('state',state);
  return privateRedirect(destination);
}

function privateRedirect(destination){
  const response=NextResponse.redirect(destination,303);
  response.headers.set('Cache-Control','private, no-store, max-age=0');
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('X-Robots-Tag','noindex, nofollow');
  return response;
}

function clientIp(request){
  const forwarded=request.headers.get('x-vercel-forwarded-for')
    ||request.headers.get('x-forwarded-for')
    ||'';
  return clean(
    forwarded.split(',')[0]
      ||request.headers.get('x-real-ip')
      ||'unknown',
    80
  );
}

function clean(value,max){
  return String(value??'').replace(/[\u0000-\u001F\u007F]/g,' ')
    .trim().slice(0,max);
}
