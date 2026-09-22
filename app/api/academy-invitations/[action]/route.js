import {createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {ACCESS_COOKIE,REFRESH_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {validAcademySlug,academyTrainingPath} from '../../../../lib/academy-policy.mjs';
import {academyBasePath} from '../../../../lib/academy-navigation.mjs';
import {normalizeRecoveryEmail,recoveryRedirectUrl} from '../../../../lib/password-recovery.mjs';
import {readTrainingBody,validTrainingToken,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingFailure,trainingRpc} from '../../../../lib/training-server';

export const dynamic='force-dynamic';

function setAcademySession(response,session){
  const options={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/'};
  response.cookies.set(ACCESS_COOKIE,session.access_token,{...options,maxAge:Math.min(Math.max(Number(session.expires_in)||3600,1),3600)});
  response.cookies.set(REFRESH_COOKIE,session.refresh_token,{...options,maxAge:60*60*24*30});
}

async function authRequest(path,body){
  let response;
  try{
    response=await fetch(`${SUPABASE_URL}${path}`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)
    });
  }catch{throw trainingProblem('network_unavailable',503);}
  const data=await response.json().catch(()=>null);
  if(!data)throw trainingProblem('network_unavailable',503);
  return {response,data};
}

function validSession(session){
  return typeof session?.access_token==='string'&&session.access_token.length>0
    &&typeof session?.refresh_token==='string'&&session.refresh_token.length>0;
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!['preview','register','login','accept'].includes(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:8192});
    if(!validAcademySlug(body.tenantSlug))throw trainingProblem('invalid_request');
    if(!validTrainingToken(body.token))throw trainingProblem('invalid_invitation');
    // SQL is the sole authority for the invitation's identity and role. Client
    // tenant IDs, roles and navigation targets are never forwarded.
    const inviteArgs={p_slug:body.tenantSlug,p_token_hash:createHash('sha256').update(body.token).digest('hex')};
    let invitation=null,email=null;
    if(action==='preview'||action==='register'){
      invitation=await trainingRpc('v1_academy_invitation_preview',inviteArgs,{publicAccess:true});
      email=normalizeRecoveryEmail(invitation?.email);
      if(invitation?.slug!==body.tenantSlug||!invitation?.tenantId||!email)throw trainingProblem('invalid_invitation');
      if(action==='preview')return trainingJson({email,role:invitation.role});
    }else if(action==='login'){
      // Login must also work after an accepted invitation's response was lost.
      // Membership acceptance verifies this authenticated email against the
      // original invitation, including its same-subject retry path.
      email=normalizeRecoveryEmail(body.email);
      if(!email)throw trainingProblem('invalid_request');
    }

    let session=null;
    if(action==='register'||action==='login'){
      if(typeof body.password!=='string'||!body.password||body.password.length>256)throw trainingProblem('invalid_request');
      if(action==='register'&&body.password.length<12)throw trainingProblem('weak_password');
      let authPath='/auth/v1/token?grant_type=password';
      if(action==='register'){
        const target=new URL(recoveryRedirectUrl(process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL||process.env.NEXT_PUBLIC_SITE_URL));
        target.pathname='/academy/confirmed';target.searchParams.set('tenant',body.tenantSlug);
        authPath=`/auth/v1/signup?redirect_to=${encodeURIComponent(target.href)}`;
      }
      const signed=await authRequest(authPath,{email,password:body.password});
      if(!signed.response.ok){
        if(signed.response.status===429)return trainingJson({error:'محاولات كثيرة. انتظر قليلًا وأعد المحاولة.'},429);
        if(action==='register'&&['email_exists','user_already_exists'].includes(signed.data.code))throw trainingProblem('account_already_exists',409);
        if(signed.data.code==='email_not_confirmed')return trainingJson({error:'أكد بريدك الإلكتروني، ثم افتح رابط الدعوة الأصلي وسجّل الدخول.'},401);
        throw trainingProblem(action==='login'?'invalid_credentials':'invalid_request',action==='login'?401:400);
      }
      session=signed.data.session||signed.data;
      if(action==='register'&&!session.access_token){
        // Confirming the email never consumes the invitation. The recipient
        // returns to the original link and accepts using their confirmed login.
        const account=signed.data.user||signed.data;
        if(Array.isArray(account.identities)&&account.identities.length===0)throw trainingProblem('account_already_exists',409);
        if(!account.id)throw trainingProblem('network_unavailable',503);
        return trainingJson({success:true,confirmationRequired:true});
      }
      if(!validSession(session))throw trainingProblem('network_unavailable',503);
    }
    const bearer=session?.access_token||(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!bearer)throw trainingProblem('unauthenticated',401);
    // This RPC verifies the confirmed Auth email and invitation, and derives the
    // membership role from that invitation. No Odeir membership is created.
    const accepted=await trainingRpc('v1_academy_membership_accept',inviteArgs,{token:bearer});
    if(accepted?.slug!==body.tenantSlug||!accepted.tenantId||(invitation&&accepted.tenantId!==invitation.tenantId))throw trainingProblem('invalid_invitation');
    const next=accepted.role==='instructor'?academyTrainingPath(body.tenantSlug,'instructor'):academyBasePath(body.tenantSlug);
    const response=trainingJson({success:true,next});
    if(session)setAcademySession(response,session);
    return response;
  }catch(error){return trainingFailure(error);}
}
