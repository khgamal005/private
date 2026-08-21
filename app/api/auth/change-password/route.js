import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const dynamic='force-dynamic';

export async function POST(request){
  try{
    const {password,confirm}=await request.json();
    if(typeof password!=='string'||password.length<12){
      return json({error:'كلمة المرور يجب ألا تقل عن 12 حرفًا'},{status:400});
    }
    if(password!==confirm){
      return json({error:'كلمتا المرور غير متطابقتين'},{status:400});
    }

    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة'},{status:401});

    const passwordResponse=await fetch(SUPABASE_URL+'/auth/v1/user',{
      method:'PUT',
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:'Bearer '+token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({password}),
      cache:'no-store'
    });
    if(!passwordResponse.ok){
      console.error('[password-change-provider-failure]',{
        status:passwordResponse.status
      });
      return json({error:'تعذر تغيير كلمة المرور'},{status:400});
    }

    const markResponse=await fetch(
      SUPABASE_URL+'/rest/v1/rpc/v2_mark_password_changed',
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:'Bearer '+token,
          'Content-Type':'application/json'
        },
        body:'{}',
        cache:'no-store'
      }
    );
    if(!markResponse.ok){
      console.error('[password-change-state-failure]',{
        status:markResponse.status
      });
      return json({
        error:'تم تغيير كلمة المرور لكن تعذر تحديث حالة الحساب'
      },{status:500});
    }
    return json({success:true,next:'/control'});
  }catch(error){
    console.error('[password-change-unexpected]',{
      name:error instanceof Error?error.name:'Error',
      message:error instanceof Error?error.message:String(error)
    });
    return json({
      error:'تعذر تغيير كلمة المرور'
    },{status:500});
  }
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
