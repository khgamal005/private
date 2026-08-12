import {NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {
  SUPABASE_URL,
  SUPABASE_KEY,
  ACCESS_COOKIE,
  REFRESH_COOKIE
} from '../../../../lib/config';

export async function POST(){
  const cookieStore=await cookies();
  const token=cookieStore.get(ACCESS_COOKIE)?.value;

  if(token){
    await fetch(`${SUPABASE_URL}/auth/v1/logout`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`
      }
    }).catch(()=>{});
  }

  // Keep the redirect relative. Behind a reverse proxy, request.url may contain
  // the internal Next.js listener address (for example 0.0.0.0:3000).
  const response=new NextResponse(null,{
    status:303,
    headers:{
      Location:'/login',
      'Cache-Control':'private, no-store'
    }
  });
  response.cookies.set(ACCESS_COOKIE,'',{path:'/',maxAge:0});
  response.cookies.set(REFRESH_COOKIE,'',{path:'/',maxAge:0});
  return response;
}
