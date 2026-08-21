import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {
  normalizeRecoveryEmail,
  recoveryRedirectUrl
} from '../../../../lib/password-recovery.mjs';

export const dynamic='force-dynamic';

export async function POST(request){
  try{
    const {email:input}=await request.json();
    const email=normalizeRecoveryEmail(input);
    if(!email){
      return json({error:'أدخل بريدًا إلكترونيًا صحيحًا'},{status:400});
    }

    const redirectTo=recoveryRedirectUrl(
      process.env.NEXT_PUBLIC_APP_URL
      ||process.env.APP_URL
      ||process.env.NEXT_PUBLIC_SITE_URL
    );
    const response=await fetch(
      `${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({email}),
        cache:'no-store'
      }
    );

    if(response.status===429){
      return json({
        error:'تم إرسال طلب مؤخرًا. انتظر قليلًا ثم حاول مرة أخرى.'
      },{status:429});
    }
    if(!response.ok){
      console.error('[password-recovery-provider-failure]',{
        status:response.status
      });
      return json({error:'تعذر إرسال رابط الاستعادة الآن'},{status:503});
    }

    return json({success:true});
  }catch(error){
    console.error('[password-recovery-unexpected]',{
      name:error instanceof Error?error.name:'Error'
    });
    return json({error:'تعذر إرسال رابط الاستعادة الآن'},{status:500});
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
