import 'server-only';
import {authRpc} from './server-auth';
import {SUPABASE_SECRET_KEY} from './admin-config';
import {SUPABASE_KEY,SUPABASE_URL} from './config';

const EDGE_FUNCTION='odeir-registration-intake';

export async function getPlatformRegistrationPolicy(){
  const policy=await authRpc('v1_platform_registration_policy_snapshot');
  return {...policy,emailReady:await registrationEmailReady()};
}

export async function registrationEmailReady(){
  const ingressToken=process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'';
  const serverKey=SUPABASE_SECRET_KEY||'';
  if(!ingressToken&&!serverKey)return false;
  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:ingressToken?SUPABASE_KEY:serverKey,
          'content-type':'application/json',
          ...(ingressToken?{'x-odeir-intake-token':ingressToken}:{})
        },
        body:JSON.stringify({action:'health'}),
        cache:'no-store',
        signal:AbortSignal.timeout(6_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    return response.ok&&result.ok===true&&result.emailReady===true;
  }catch{return false;}
}
