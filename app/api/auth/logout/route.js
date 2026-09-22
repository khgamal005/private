import {NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {
  SUPABASE_URL,
  SUPABASE_KEY,
  ACCESS_COOKIE,
  REFRESH_COOKIE
} from '../../../../lib/config';

export async function POST(request){
  let destination='/login';
  if(request?.headers?.get('content-type')?.includes('application/x-www-form-urlencoded')){
    const form=await request.formData().catch(()=>null);
    const workspace=form?.get('workspace');
    if(workspace==='academy')destination='/academy/login';
    if(workspace==='training'){
      const role=form?.get('role')==='instructor'?'instructor':'learner';
      const tenant=String(form?.get('tenant')||'');
      const academyTraining=form?.get('trainingWorkspace')==='academy'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenant);
      destination=academyTraining?`/training/login?tenant=${encodeURIComponent(tenant)}&workspace=academy&role=${role}`:`/training/login?role=${role}`;
    }
  }
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
      Location:destination,
      'Cache-Control':'private, no-store'
    }
  });
  response.cookies.set(ACCESS_COOKIE,'',{path:'/',maxAge:0});
  response.cookies.set(REFRESH_COOKIE,'',{path:'/',maxAge:0});
  return response;
}
