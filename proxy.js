import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_URL,
  SUPABASE_KEY
} from './lib/config';

const COOKIE_OPTIONS={
  httpOnly:true,
  secure:true,
  sameSite:'lax',
  path:'/'
};

function expiresAt(token){
  try{
    const payload=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(payload)).exp||0;
  }catch{
    return 0;
  }
}

function isProtected(pathname){
  return pathname.startsWith('/control')
    ||pathname.startsWith('/tenant')
    ||pathname.startsWith('/change-password')
    ||pathname.startsWith('/api/tenant')
    ||pathname.startsWith('/api/crm')
    ||pathname.startsWith('/api/platform')
    ||pathname.startsWith('/api/woocommerce')
    ||pathname.startsWith('/api/commerce')
    ||pathname.startsWith('/api/marketing')
    ||pathname.startsWith('/api/accounting');
}

function refreshedResponse(req,session,currentRefresh){
  const accessToken=session.access_token;
  const refreshToken=session.refresh_token||currentRefresh;

  // Server Components must receive the new tokens on this same request.
  req.cookies.set(ACCESS_COOKIE,accessToken);
  req.cookies.set(REFRESH_COOKIE,refreshToken);
  const response=NextResponse.next({request:req});

  // The browser also needs the rotated pair for subsequent requests.
  response.cookies.set(ACCESS_COOKIE,accessToken,{
    ...COOKIE_OPTIONS,
    maxAge:session.expires_in||3600
  });
  response.cookies.set(REFRESH_COOKIE,refreshToken,{
    ...COOKIE_OPTIONS,
    maxAge:2592000
  });
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export async function proxy(req){
  const pathname=req.nextUrl.pathname;
  if(!isProtected(pathname))return NextResponse.next();

  const access=req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh=req.cookies.get(REFRESH_COOKIE)?.value;
  if(access&&expiresAt(access)>Math.floor(Date.now()/1000)+60){
    return NextResponse.next();
  }

  if(refresh){
    try{
      const response=await fetch(
        `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        {
          method:'POST',
          headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
          body:JSON.stringify({refresh_token:refresh}),
          cache:'no-store',
          signal:AbortSignal.timeout(8000)
        }
      );
      if(response.ok){
        return refreshedResponse(req,await response.json(),refresh);
      }
    }catch(error){
      console.error('[session-refresh-failed]',{
        name:error instanceof Error?error.name:'UnknownError'
      });
    }
  }

  if(pathname.startsWith('/api/')){
    return NextResponse.json(
      {error:'انتهت الجلسة'},
      {status:401,headers:{'Cache-Control':'private, no-store'}}
    );
  }
  const loginUrl=req.nextUrl.clone();
  loginUrl.pathname='/login';
  loginUrl.search='';
  loginUrl.searchParams.set('next',`${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config={
  matcher:[
    '/control/:path*',
    '/tenant/:path*',
    '/change-password',
    '/api/tenant/:path*',
    '/api/crm/:path*',
    '/api/platform/:path*',
    '/api/woocommerce/:path*',
    '/api/commerce/:path*',
    '/api/marketing/:path*',
    '/api/accounting/:path*'
  ]
};
