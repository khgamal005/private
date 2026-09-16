import {createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {ACCESS_COOKIE,REFRESH_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {readTrainingBody,validTrainingId,validTrainingToken,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingFailure,trainingRpc} from '../../../../lib/training-server';

export const dynamic='force-dynamic';

function setTrainingSession(response,session){
  const options={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/'};
  response.cookies.set(ACCESS_COOKIE,session.access_token,{...options,maxAge:Math.min(Number(session.expires_in)||3600,3600)});
  response.cookies.set(REFRESH_COOKIE,session.refresh_token,{...options,maxAge:60*60*24*30});
}

async function upstream(path,body){
  let response;
  try{
    response=await fetch(`${SUPABASE_URL}${path}`,{method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  }catch{throw trainingProblem('network_unavailable',503);}
  const data=await response.json().catch(()=>({}));
  return {response,data};
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!['login','register','accept'].includes(action))return trainingJson({error:'الإجراء غير موجود.'},404);
    const body=await readTrainingBody(request,{maxBytes:8192});
    const token=body.token;
    const role=body.role||'learner';
    if(!['learner','instructor'].includes(role)||(token&&role!=='learner'))throw trainingProblem('invalid_request');
    if((action!=='login'||token)&&!validTrainingToken(token))throw trainingProblem('invalid_invitation');
    if(token&&!validTrainingId(body.commandId))throw trainingProblem('command_id_required');
    let session=null;
    if(action==='register'){
      if(typeof body.password!=='string'||body.password.length<12||body.password.length>256)throw trainingProblem('weak_password');
      const {response,data}=await upstream('/functions/v1/training-invitation-activation',{token,password:body.password,claimId:body.commandId});
      if(!response.ok)throw trainingProblem(String(data.error||'activation_failed'),response.status===409?409:400);
      if(!data.session?.access_token||!data.session?.refresh_token)throw trainingProblem('network_unavailable',503);
      session=data.session;
    }else{
      if(action==='login'){
        if(typeof body.email!=='string'||body.email.length>254||!body.email.includes('@')||typeof body.password!=='string'||!body.password||body.password.length>256)throw trainingProblem('invalid_request');
        const signed=await upstream('/auth/v1/token?grant_type=password',{email:body.email.trim().toLowerCase(),password:body.password});
        if(!signed.response.ok)throw trainingProblem('invalid_credentials',signed.response.status===429?429:401);
        if(typeof signed.data.access_token!=='string'||!signed.data.access_token||typeof signed.data.refresh_token!=='string'||!signed.data.refresh_token)throw trainingProblem('network_unavailable',503);
        session=signed.data;
      }
      const bearer=session?.access_token||(await cookies()).get(ACCESS_COOKIE)?.value;
      if(!bearer)throw trainingProblem('unauthenticated',401);
      if(token){
        await trainingRpc('v1_training_learning_action',{
          p_tenant_slug:'marktone',p_action:'accept_invitation',p_command_id:body.commandId,
          p_payload:{tokenHash:createHash('sha256').update(token).digest('hex')}
        },{token:bearer});
      }else{
        // A successful password grant alone does not authorize any training data.
        await trainingRpc('v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:role},{token:bearer});
      }
    }
    const result=trainingJson({success:true,next:role==='instructor'?'/training/marktone?role=instructor':'/training/marktone'});
    if(session)setTrainingSession(result,session);
    return result;
  }catch(error){return trainingFailure(error);}
}
