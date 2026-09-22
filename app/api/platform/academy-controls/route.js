import {createHash} from 'node:crypto';
import {academyAdminPayload,academyAdminError,academySlug} from '../../../../lib/academy-admin.mjs';
import {readTrainingBody,validTrainingId,validTrainingToken,trainingProblem} from '../../../../lib/training-request.mjs';
import {trainingJson,trainingRpc} from '../../../../lib/training-server';

export const dynamic='force-dynamic';

function failure(error){
  return trainingJson({error:academyAdminError(String(error?.code||'')),retryable:error?.code==='network_unavailable'},error?.status||503);
}

export async function GET(request){
  try{
    const slug=new URL(request.url).searchParams.get('slug');
    if(!academySlug(slug))throw trainingProblem('invalid_request');
    const data=await trainingRpc('v1_platform_academy_snapshot',{p_slug:slug});
    return trainingJson({success:true,data});
  }catch(error){return failure(error);}
}

export async function POST(request){
  try{
    const body=await readTrainingBody(request,{maxBytes:8192});
    if(!academySlug(body.slug)||!validTrainingId(body.commandId))throw trainingProblem('invalid_request');
    const payload=academyAdminPayload(body.action,body.payload);
    let invitationUrl;
    if(body.action==='issue_invitation'){
      if(!validTrainingToken(body.invitationToken))throw trainingProblem('invalid_invitation');
      payload.tokenHash=createHash('sha256').update(body.invitationToken).digest('hex');
      invitationUrl=`/academy/accept?tenant=${encodeURIComponent(body.slug)}#${body.invitationToken}`;
    }
    const data=await trainingRpc('v1_platform_academy_action',{
      p_slug:body.slug,p_action:body.action,p_command_id:body.commandId,p_payload:payload
    });
    return trainingJson({success:true,data,...(invitationUrl?{invitationUrl}:{})});
  }catch(error){return failure(error);}
}
