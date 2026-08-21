import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';
import {validateRecoveryPassword} from '../../../../lib/password-recovery.mjs';

export const dynamic='force-dynamic';

export async function POST(request){
  try{
    const {accessToken,tokenHash,password,confirm}=await request.json();
    const validationError=validateRecoveryPassword(password,confirm);
    if(validationError){
      return json({error:validationError},{status:400});
    }

    const token=await recoveryAccessToken({accessToken,tokenHash});
    if(!token){
      return json({
        error:'انتهت صلاحية رابط الاستعادة أو تم استخدامه من قبل.'
      },{status:401});
    }

    const passwordResponse=await fetch(`${SUPABASE_URL}/auth/v1/user`,{
      method:'PUT',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({password}),
      cache:'no-store'
    });
    if(!passwordResponse.ok){
      console.error('[password-recovery-update-failure]',{
        status:passwordResponse.status
      });
      return json({
        error:passwordResponse.status===401
          ?'انتهت صلاحية رابط الاستعادة. اطلب رابطًا جديدًا.'
          :'تعذر تعيين كلمة المرور الجديدة'
      },{status:passwordResponse.status===401?401:400});
    }

    await markPasswordChanged(token);
    await revokeRecoverySession(token);

    const response=json({success:true});
    clearCookie(response,ACCESS_COOKIE);
    clearCookie(response,REFRESH_COOKIE);
    return response;
  }catch(error){
    console.error('[password-recovery-update-unexpected]',{
      name:error instanceof Error?error.name:'Error'
    });
    return json({error:'تعذر تعيين كلمة المرور الجديدة'},{status:500});
  }
}

async function recoveryAccessToken({accessToken,tokenHash}){
  if(typeof accessToken==='string'&&accessToken.length>20){
    return accessToken;
  }
  if(typeof tokenHash!=='string'||tokenHash.length<20)return null;

  const response=await fetch(`${SUPABASE_URL}/auth/v1/verify`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({type:'recovery',token_hash:tokenHash}),
    cache:'no-store'
  });
  if(!response.ok)return null;
  const session=await response.json().catch(()=>null);
  return session?.access_token||null;
}

async function markPasswordChanged(token){
  try{
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_mark_password_changed`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:'{}',
        cache:'no-store'
      }
    );
    if(!response.ok){
      console.error('[password-recovery-state-failure]',{
        status:response.status
      });
    }
  }catch(error){
    console.error('[password-recovery-state-network-failure]',{
      name:error instanceof Error?error.name:'Error'
    });
  }
}

async function revokeRecoverySession(token){
  try{
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`,{
      method:'POST',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${token}`
      },
      cache:'no-store'
    });
  }catch{
    // The password is already changed; a logout failure must not lock the user out.
  }
}

function clearCookie(response,name){
  response.cookies.set(name,'',{
    httpOnly:true,
    secure:process.env.NODE_ENV==='production',
    sameSite:'lax',
    path:'/',
    maxAge:0
  });
}

function json(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate'
  );
  response.headers.set('CDN-Cache-Control','no-store');
  response.headers.set('Pragma','no-cache');
  return response;
}
