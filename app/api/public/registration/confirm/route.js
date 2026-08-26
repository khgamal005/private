import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {publicAppOrigin} from '../../../../../lib/public-app-origin';

const EDGE_FUNCTION='odeir-registration-intake';
const CONFIRM_COOKIE='odeir_registration_confirm';

export async function GET(request){
  const values=request.nextUrl.searchParams.getAll('token');
  const token=String(values.length===1?values[0]:'').trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return clearConfirmCookie(redirectState('invalid'));
  }
  const destination=new URL('/registration-confirmation',publicAppOrigin());
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
  if(origin!==publicAppOrigin()){
    return clearConfirmCookie(redirectState('invalid'));
  }
  const token=String(request.cookies.get(CONFIRM_COOKIE)?.value||'')
    .trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(token)){
    return clearConfirmCookie(redirectState('invalid'));
  }

  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'content-type':'application/json'
        },
        body:JSON.stringify({action:'confirm',token}),
        cache:'no-store',
        signal:AbortSignal.timeout(30_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true){
      const invalidConfirmation=[
        'registration_confirmation_invalid',
        'registration_confirmation_already_used'
      ].includes(result.error);
      return clearConfirmCookie(redirectState(
        invalidConfirmation?'invalid':'unavailable'));
    }
    if(result.manualReviewRequired===true){
      return clearConfirmCookie(redirectState('manual_review'));
    }
    if(typeof result.invitationToken==='string'&&result.invitationToken.length>=32){
      const destination=new URL('/accept-invite',publicAppOrigin());
      destination.searchParams.set('token',result.invitationToken);
      destination.searchParams.set('source','email-confirmed-registration');
      return clearConfirmCookie(privateRedirect(destination));
    }
    const destination=new URL('/login',publicAppOrigin());
    destination.searchParams.set('reason','registration_confirmed');
    if(result.tenantSlug)destination.searchParams.set('tenant',String(result.tenantSlug));
    return clearConfirmCookie(privateRedirect(destination));
  }catch(error){
    console.error('odeir_registration_confirmation_failed',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return clearConfirmCookie(redirectState('unavailable'));
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

function redirectState(state){
  const destination=new URL('/registration-confirmation',publicAppOrigin());
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
