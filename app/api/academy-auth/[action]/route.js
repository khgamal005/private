import {ACCESS_COOKIE,REFRESH_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {readTrainingBody,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingFailure,trainingRpc} from '../../../../lib/training-server';
import {academyAccessAllowed,validAcademySlug} from '../../../../lib/academy-policy.mjs';
import {normalizeRecoveryEmail,recoveryRedirectUrl} from '../../../../lib/password-recovery.mjs';
export const dynamic='force-dynamic';
export async function POST(request,{params}){
  try{
    const {action}=await params;if(!['login','recover'].includes(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:8192}),email=normalizeRecoveryEmail(body.email);
    if(!validAcademySlug(body.tenantSlug)||!email)throw trainingProblem('invalid_request');
    if(action==='recover'){
      const target=new URL(recoveryRedirectUrl(process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL||process.env.NEXT_PUBLIC_SITE_URL));
      target.searchParams.set('workspace','academy');target.searchParams.set('tenant',body.tenantSlug);
      const response=await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(target.href)}`,{method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify({email}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)return trainingJson({error:response.status===429?'تم إرسال طلب مؤخرًا. انتظر قليلًا ثم حاول مرة أخرى.':'تعذر إرسال رابط الاستعادة الآن.'},response.status===429?429:503);
      return trainingJson({success:true});
    }
    if(typeof body.password!=='string'||!body.password||body.password.length>256)throw trainingProblem('invalid_request');
    const response=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password:body.password}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    const session=await response.json().catch(()=>null);
    if(!response.ok)throw trainingProblem('invalid_credentials',response.status===429?429:401);
    if(!session?.access_token||!session?.refresh_token)throw trainingProblem('network_unavailable',503);
    const access=await trainingRpc('v1_academy_workspace_snapshot',{p_slug:body.tenantSlug},{token:session.access_token});
    if(!academyAccessAllowed(access,body.tenantSlug,{management:true}))throw trainingProblem('forbidden',403);
    const result=trainingJson({success:true,next:`/academy/${encodeURIComponent(body.tenantSlug)}`});
    const options={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/'};
    result.cookies.set(ACCESS_COOKIE,session.access_token,{...options,maxAge:Math.min(Number(session.expires_in)||3600,3600)});
    result.cookies.set(REFRESH_COOKIE,session.refresh_token,{...options,maxAge:60*60*24*30});
    return result;
  }catch(error){
    if(error?.code==='password_change_required')return trainingJson({error:'عيّن كلمة مرور خاصة بك من خلال رابط استعادة الحساب قبل المتابعة.',passwordRequired:true},403);
    return trainingFailure(error);
  }
}
